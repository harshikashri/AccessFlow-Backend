import mongoose from 'mongoose';
import AuditLog from '../../../models/AuditLog.js';
import ApprovalStep from '../../../models/ApprovalStep.js';
import Request from '../../../models/Request.js';
import User from '../../../models/User.js';
import { AppError } from '../../../utils/AppError.js';
import { hasEffectivePermission } from '../../../services/authorization/permission.service.js';
import {
  getRequestVisibilityFilter,
  resolveRequestVisibility,
} from '../../requests/request.service.js';

const oid = (value) => new mongoose.Types.ObjectId(String(value));

const REQUEST_ACTIONS = [
  'REQUEST_CREATED',
  'REQUEST_UPDATED',
  'REQUEST_SUBMITTED',
  'REQUEST_RESUBMITTED',
  'REQUEST_CANCELLED',
  'REQUEST_RETURNED',
  'REQUEST_APPROVED',
];

const APPROVAL_ACTIONS = [
  'APPROVAL_CLAIMED',
  'APPROVAL_GRANTED',
  'APPROVAL_REJECTED',
  'APPROVAL_CANCELLED',
  'APPROVAL_STAGE_ACTIVATED',
  'APPROVAL_STAGES_CREATED',
  'APPROVAL_OVERDUE',
  'APPROVAL_ESCALATED',
  'APPROVAL_CLAIM_EXPIRED',
  'REQUEST_APPROVED',
  'REQUEST_RETURNED',
];

const DELEGATION_ACTIONS = ['DELEGATION_CREATED', 'DELEGATION_UPDATED', 'DELEGATION_REVOKED'];

const ACTION_LABELS = {
  REQUEST_CREATED: 'Request created',
  REQUEST_UPDATED: 'Request updated',
  REQUEST_SUBMITTED: 'Request submitted',
  REQUEST_RESUBMITTED: 'Request resubmitted',
  REQUEST_CANCELLED: 'Request cancelled',
  REQUEST_RETURNED: 'Request returned',
  REQUEST_APPROVED: 'Request approved',
  APPROVAL_CLAIMED: 'Approval claimed',
  APPROVAL_GRANTED: 'Approval completed',
  APPROVAL_REJECTED: 'Approval rejected',
  APPROVAL_CANCELLED: 'Approval cancelled',
  APPROVAL_STAGE_ACTIVATED: 'Approval stage activated',
  APPROVAL_STAGES_CREATED: 'Approval stages created',
  APPROVAL_OVERDUE: 'Approval overdue',
  APPROVAL_ESCALATED: 'Approval escalated',
  APPROVAL_CLAIM_EXPIRED: 'Approval claim expired',
  DELEGATION_CREATED: 'Approval delegation created',
  DELEGATION_UPDATED: 'Approval delegation updated',
  DELEGATION_REVOKED: 'Approval delegation revoked',
};

const getActiveDelegators = async ({ organizationId, userId, now }) => {
  const users = await User.find({
    accountStatus: 'ACTIVE',
    organizationMemberships: { $elemMatch: { organizationId, status: 'ACTIVE' } },
    approvalDelegations: {
      $elemMatch: {
        organizationId,
        delegateId: userId,
        status: 'ACTIVE',
        startsAt: { $lte: now },
        endsAt: { $gt: now },
      },
    },
  }).select('_id approvalDelegations').lean();
  return users.map((user) => ({
    userId: user._id,
    delegations: user.approvalDelegations.filter((item) =>
      String(item.organizationId) === String(organizationId) &&
      String(item.delegateId) === String(userId) &&
      item.status === 'ACTIVE' &&
      item.startsAt <= now &&
      item.endsAt > now
    ),
  }));
};

const delegationApplies = (delegation, step, now) =>
  (delegation.scopeType === 'ORGANIZATION' ||
    String(delegation.departmentId) === String(step.departmentId)) &&
  (!delegation.stageIds.length || delegation.stageIds.includes(step.stageId)) &&
  delegation.startsAt <= now &&
  delegation.endsAt > now;

const managerAssignedRequestIds = async ({ organizationId, userId, access, now }) => {
  const delegators = await getActiveDelegators({ organizationId, userId, now });
  const delegatorIds = delegators.map((item) => item.userId);
  const steps = await ApprovalStep.find({
    organizationId,
    $or: [
      { approverId: userId },
      ...(delegatorIds.length ? [{ approverId: { $in: delegatorIds } }] : []),
    ],
    status: { $in: ['ACTIVE', 'CLAIMED', 'APPROVED', 'REJECTED', 'RETURNED'] },
  }).select('requestId attemptNumber stageId sequence approverId status claimedBy claimExpiresAt decidedBy returnedBy actedOnBehalfOf').lean();
  const requestIds = [...new Set(steps.map((step) => String(step.requestId)))];
  if (!requestIds.length) return [];
  const requests = await Request.find({ organizationId, _id: { $in: requestIds } })
    .select('_id departmentId status currentSequence')
    .lean();
  const departmentByRequest = new Map(requests.map((request) => [String(request._id), request.departmentId]));
  const requestById = new Map(requests.map((request) => [String(request._id), request]));
  const allowedDelegations = new Map(delegators.map((item) => [String(item.userId), item.delegations]));
  const activeRequestIds = [...new Set(steps
    .filter((step) => ['ACTIVE', 'CLAIMED'].includes(step.status))
    .map((step) => step.requestId))];
  const attempts = activeRequestIds.length
    ? await ApprovalStep.aggregate([
      { $match: { organizationId: oid(organizationId), requestId: { $in: activeRequestIds } } },
      { $group: { _id: '$requestId', attemptNumber: { $max: '$attemptNumber' } } },
    ])
    : [];
  const currentAttempt = new Map(attempts.map((item) => [String(item._id), item.attemptNumber]));
  const claimedStages = activeRequestIds.length
    ? await ApprovalStep.aggregate([
      {
        $match: {
          organizationId: oid(organizationId),
          requestId: { $in: activeRequestIds },
          status: 'CLAIMED',
          $or: [{ claimExpiresAt: null }, { claimExpiresAt: { $gt: now } }],
        },
      },
      {
        $group: {
          _id: { requestId: '$requestId', attemptNumber: '$attemptNumber', sequence: '$sequence' },
          claimedBy: { $addToSet: '$claimedBy' },
        },
      },
    ])
    : [];
  const claimedByOther = new Set(claimedStages
    .filter(({ _id, claimedBy }) =>
      Number(_id.attemptNumber) === Number(currentAttempt.get(String(_id.requestId))) &&
      claimedBy.some((claimer) => claimer && String(claimer) !== String(userId))
    )
    .map(({ _id }) => `${_id.requestId}:${_id.attemptNumber}:${_id.sequence}`));
  return [...new Set(steps.filter((step) => {
    const departmentId = departmentByRequest.get(String(step.requestId));
    if (!departmentId || !hasEffectivePermission(access, 'requests.approve', departmentId)) return false;
    if (['ACTIVE', 'CLAIMED'].includes(step.status)) {
      const requestDoc = requestById.get(String(step.requestId));
      const key = `${step.requestId}:${step.attemptNumber}:${step.sequence}`;
      if (requestDoc.status !== 'PENDING_APPROVAL' ||
          requestDoc.currentSequence !== step.sequence ||
          Number(step.attemptNumber) !== Number(currentAttempt.get(String(step.requestId))) ||
          (step.status === 'CLAIMED' && step.claimExpiresAt && step.claimExpiresAt <= now) ||
          claimedByOther.has(key)) return false;
    }
    const assignedToActor = String(step.approverId) === String(userId);
    const hasValidDelegation = (allowedDelegations.get(String(step.approverId)) || []).some((delegation) =>
      delegationApplies(delegation, { ...step, departmentId }, now)
    );
    if (!assignedToActor && !hasValidDelegation) return false;
    if (['ACTIVE', 'CLAIMED'].includes(step.status)) {
      return step.status === 'CLAIMED' && String(step.claimedBy) === String(userId);
    }
    return [step.claimedBy, step.decidedBy, step.returnedBy]
      .some((actorId) => String(actorId) === String(userId));
  }).map((step) => String(step.requestId)))];
};

export const getRecentActivity = async ({
  userId,
  organizationId,
  access,
  platformRole,
  dateRange,
  page,
  limit,
}) => {
  if (platformRole === 'SUPER_ADMIN') {
    return {
      scope: 'PLATFORM',
      items: [],
      pagination: { page, limit, total: 0, totalPages: 0 },
    };
  }
  const canViewRequest = access.organizationPermissions.has('requests.view') ||
    (access.scopedPermissions.get('requests.view')?.size || 0) > 0;
  const canApprove = access.organizationPermissions.has('requests.approve') ||
    (access.scopedPermissions.get('requests.approve')?.size || 0) > 0;
  const auditDepartmentIds = access.scopedPermissions.get('audit_logs.view') || new Set();
  const canViewAuditOrganization = access.organizationPermissions.has('audit_logs.view');
  const canViewAudit = canViewAuditOrganization || auditDepartmentIds.size > 0;
  if (!canViewRequest && !canApprove && !canViewAudit) {
    throw new AppError('Request, approval, or audit permission is required for recent activity.', 403, 'FORBIDDEN');
  }

  const visibility = await resolveRequestVisibility({ organizationId, actorId: userId, access });
  const visibilityFilter = getRequestVisibilityFilter({ actorId: userId, requestVisibility: visibility });
  const visibleRequestIds = !canViewRequest
    ? []
    : visibility.canViewOrganization
      ? null
      : (await Request.find({ organizationId, ...visibilityFilter }).distinct('_id'));

  let approvalRequestIds = [];
  if (canApprove) {
    approvalRequestIds = await managerAssignedRequestIds({
      organizationId,
      userId,
      access,
      now: new Date(),
    });
    if (visibleRequestIds?.length) {
      approvalRequestIds = [...new Set([
        ...approvalRequestIds,
        ...visibleRequestIds.map(String),
      ])];
    }
  }

  const adminCanSeeApproval = canApprove && visibility.canViewOrganization &&
    access.organizationPermissions.has('requests.approve');
  const canSeeApprovalAssignments = adminCanSeeApproval || approvalRequestIds.length > 0;
  const canViewRequestEvents = canViewRequest || canViewAudit;
  const canViewApprovalEvents = canApprove || canViewAudit;
  const canViewDelegationEvents = canApprove || canViewAuditOrganization;
  const filter = {
    organizationId: oid(organizationId),
    timestamp: { $gte: dateRange.fromDate, $lt: dateRange.toDate },
    $or: [
      ...(canViewRequestEvents
        ? [{ resourceType: 'Request', action: { $in: REQUEST_ACTIONS } }]
        : []),
      ...(canViewApprovalEvents
        ? [{ resourceType: 'Approval', action: { $in: APPROVAL_ACTIONS } }]
        : []),
      ...(canViewDelegationEvents
        ? [{
          resourceType: 'ApprovalDelegation',
          action: { $in: DELEGATION_ACTIONS },
          ...(canViewAuditOrganization ? {} : { actorId: oid(userId) }),
        }]
        : []),
    ],
  };
  const pipeline = [
    { $match: filter },
    { $project: { organizationId: 1, actorId: 1, action: 1, resourceType: 1, resourceId: 1, timestamp: 1 } },
    { $sort: { timestamp: -1, _id: -1 } },
    {
      $lookup: {
        from: 'requests',
        let: {
          resourceId: '$resourceId',
          organizationId: '$organizationId',
          resourceType: '$resourceType',
        },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$$resourceType', 'Request'] },
                  { $eq: ['$_id', '$$resourceId'] },
                  { $eq: ['$organizationId', '$$organizationId'] },
                ],
              },
            },
          },
          { $project: { _id: 1, requestNumber: 1, requestType: 1, requestTypeName: 1, departmentId: 1 } },
        ],
        as: 'directRequest',
      },
    },
    {
      $lookup: {
        from: 'approvalSteps',
        let: { resourceId: '$resourceId', organizationId: '$organizationId' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$_id', '$$resourceId'] },
                  { $eq: ['$organizationId', '$$organizationId'] },
                ],
              },
            },
          },
          { $project: { requestId: 1, stageId: 1, stageName: 1, sequence: 1 } },
          {
            $lookup: {
              from: 'requests',
              let: { requestId: '$requestId', organizationId: '$$organizationId' },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        { $eq: ['$_id', '$$requestId'] },
                        { $eq: ['$organizationId', '$$organizationId'] },
                      ],
                    },
                  },
                },
                { $project: { _id: 1, requestNumber: 1, requestType: 1, requestTypeName: 1, departmentId: 1 } },
              ],
              as: 'request',
            },
          },
          { $unwind: { path: '$request', preserveNullAndEmptyArrays: true } },
        ],
        as: 'approvalStep',
      },
    },
    { $unwind: { path: '$approvalStep', preserveNullAndEmptyArrays: true } },
    {
      $set: {
        request: {
          $cond: [
            { $eq: ['$resourceType', 'Approval'] },
            '$approvalStep.request',
            { $arrayElemAt: ['$directRequest', 0] },
          ],
        },
        stage: {
          $cond: [
            {
              $and: [
                { $eq: ['$resourceType', 'Approval'] },
                { $ne: ['$approvalStep.stageId', null] },
              ],
            },
            { id: '$approvalStep.stageId', name: '$approvalStep.stageName' },
            null,
          ],
        },
      },
    },
    {
      $match: {
        $or: [
          {
            resourceType: 'ApprovalDelegation',
            actorId: oid(userId),
          },
          ...(canViewRequest || canViewAudit
            ? [{
            resourceType: 'Request',
            'request._id': { $exists: true },
            $or: [
              ...(canViewRequest
                ? visibility.canViewOrganization
                  ? [{}]
                  : [{ 'request._id': { $in: visibleRequestIds } }]
                : []),
              ...(canViewAuditOrganization
                ? [{}]
                : auditDepartmentIds.size
                  ? [{ 'request.departmentId': { $in: [...auditDepartmentIds].map(oid) } }]
                  : []),
            ],
          }]
            : []),
          ...(canSeeApprovalAssignments || canViewAudit
            ? [{
            resourceType: 'Approval',
            'request._id': { $exists: true },
            $or: [
              ...(adminCanSeeApproval
                ? [{}]
                : approvalRequestIds.length
                  ? [{ 'request._id': { $in: approvalRequestIds.map(oid) } }]
                  : []),
              ...(canViewAuditOrganization
                ? [{}]
                : auditDepartmentIds.size
                  ? [{ 'request.departmentId': { $in: [...auditDepartmentIds].map(oid) } }]
                  : []),
            ],
          }]
            : []),
          ...(canApprove
            ? [{ resourceType: 'ApprovalDelegation', actorId: oid(userId) }]
            : []),
          ...(canViewAuditOrganization
            ? [{ resourceType: 'ApprovalDelegation' }]
            : []),
        ],
      },
    },
    {
      $lookup: {
        from: 'users',
        localField: 'actorId',
        foreignField: '_id',
        pipeline: [{ $project: { name: 1 } }],
        as: 'actor',
      },
    },
    { $unwind: { path: '$actor', preserveNullAndEmptyArrays: true } },
    {
      $facet: {
        items: [
          { $skip: (page - 1) * limit },
          { $limit: limit },
          {
            $project: {
              _id: 0,
              activityId: { $toString: '$_id' },
              type: {
                $cond: [
                  { $eq: ['$resourceType', 'Approval'] },
                  'APPROVAL',
                  { $cond: [{ $eq: ['$resourceType', 'ApprovalDelegation'] }, 'DELEGATION', 'REQUEST'] },
                ],
              },
              action: 1,
              actionLabel: { $literal: null },
              actorId: { $toString: '$actorId' },
              actorName: { $ifNull: ['$actor.name', null] },
              requestId: { $toString: '$request._id' },
              requestNumber: '$request.requestNumber',
              requestType: { $ifNull: ['$request.requestTypeName', '$request.requestType'] },
              stage: 1,
              timestamp: 1,
            },
          },
        ],
        metadata: [{ $count: 'total' }],
      },
    },
  ];
  const [result = { items: [], metadata: [] }] = await AuditLog.aggregate(pipeline);
  const items = (result.items || []).map((item) => ({
    ...item,
    actionLabel: ACTION_LABELS[item.action] || 'Activity recorded',
    ...(item.type === 'DELEGATION' ? { requestId: null, requestNumber: null, requestType: null } : {}),
  }));
  const total = result.metadata[0]?.total || 0;
  return {
    scope: visibility.canViewOrganization || canViewAuditOrganization
      ? 'ORGANIZATION'
      : 'AUTHORIZED_REQUESTS_AND_APPROVALS',
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages: total ? Math.ceil(total / limit) : 0,
    },
  };
};

export default { getRecentActivity };
