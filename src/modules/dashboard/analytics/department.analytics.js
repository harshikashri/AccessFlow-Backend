import mongoose from 'mongoose';
import Department from '../../../models/Department.js';
import Request from '../../../models/Request.js';
import ApprovalStep from '../../../models/ApprovalStep.js';
import User from '../../../models/User.js';
import { AppError } from '../../../utils/AppError.js';
import { hasEffectivePermission } from '../../../services/authorization/permission.service.js';
import {
  getRequestVisibilityFilter,
  resolveRequestVisibility,
} from '../../requests/request.service.js';

const oid = (value) => new mongoose.Types.ObjectId(String(value));

const hasDepartmentPermission = (access, permission) =>
  access.organizationPermissions.has(permission) ||
  (access.scopedPermissions.get(permission)?.size || 0) > 0;

const departmentRequestStats = async ({
  organizationId,
  dateRange,
  departmentIds = null,
  visibilityFilter = {},
}) => {
  const [results, departments] = await Promise.all([
    Request.aggregate([
      {
        $match: {
          organizationId: oid(organizationId),
          ...visibilityFilter,
          createdAt: { $gte: dateRange.fromDate, $lt: dateRange.toDate },
          ...(departmentIds ? { departmentId: { $in: departmentIds.map(oid) } } : {}),
        },
      },
      {
        $group: {
          _id: '$departmentId',
          totalRequests: { $sum: 1 },
          pendingRequests: {
            $sum: { $cond: [{ $in: ['$status', ['SUBMITTED', 'PENDING_APPROVAL']] }, 1, 0] },
          },
          approvedRequests: { $sum: { $cond: [{ $eq: ['$status', 'APPROVED'] }, 1, 0] } },
          rejectedRequests: { $sum: { $cond: [{ $eq: ['$status', 'REJECTED'] }, 1, 0] } },
          returnedRequests: { $sum: { $cond: [{ $eq: ['$status', 'RETURNED'] }, 1, 0] } },
        },
      },
    ]),
    Department.find({
      organizationId,
      status: 'ACTIVE',
      ...(departmentIds ? { _id: { $in: departmentIds } } : {}),
    }).select('_id name').sort({ name: 1, _id: 1 }).lean(),
  ]);
  const statsByDepartment = new Map(results.map((item) => [String(item._id), item]));
  return departments.map((department) => {
    const stats = statsByDepartment.get(String(department._id)) || {};
    return {
      departmentId: String(department._id),
      departmentName: department.name,
      totalRequests: stats.totalRequests || 0,
      pendingRequests: stats.pendingRequests || 0,
      approvedRequests: stats.approvedRequests || 0,
      rejectedRequests: stats.rejectedRequests || 0,
      returnedRequests: stats.returnedRequests || 0,
      averageApprovalMinutes: null,
    };
  });
};

const departmentDirectoryStats = async ({ organizationId, departmentIds = null }) => {
  const departments = await Department.find({
    organizationId,
    ...(departmentIds ? { _id: { $in: departmentIds } } : {}),
  }).select('_id name status').sort({ name: 1, _id: 1 }).lean();
  const counts = departments.reduce((result, department) => {
    result[department.status.toLowerCase()] += 1;
    return result;
  }, { active: 0, inactive: 0 });
  return {
    total: departments.length,
    ...counts,
    departments: departments.map((department) => ({
      departmentId: String(department._id),
      departmentName: department.name,
      status: department.status,
    })),
  };
};

const activeDelegations = async ({ organizationId, userId, now }) => {
  const delegators = await User.find({
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
  return new Map(delegators.map((user) => [String(user._id), user.approvalDelegations.filter((item) =>
    String(item.organizationId) === String(organizationId) &&
    String(item.delegateId) === String(userId) &&
    item.status === 'ACTIVE' && item.startsAt <= now && item.endsAt > now
  )]));
};

const delegated = (delegations, step, now) =>
  (delegations.get(String(step.approverId)) || []).some((item) =>
    (item.scopeType === 'ORGANIZATION' ||
      String(item.departmentId) === String(step.request.departmentId)) &&
    (!item.stageIds.length || item.stageIds.includes(step.stageId)) &&
    item.startsAt <= now &&
    item.endsAt > now
  );

const approvalWorkloadByDepartment = async ({ organizationId, userId, access, dateRange }) => {
  const now = new Date();
  const delegations = await activeDelegations({ organizationId, userId, now });
  const approverIds = [oid(userId), ...[...delegations.keys()].map(oid)];
  const steps = await ApprovalStep.aggregate([
    {
      $match: {
        organizationId: oid(organizationId),
        approverId: { $in: approverIds },
        $or: [
          { status: { $in: ['ACTIVE', 'CLAIMED'] } },
          {
            status: { $in: ['APPROVED', 'REJECTED', 'RETURNED'] },
            decisionAt: { $gte: dateRange.fromDate, $lt: dateRange.toDate },
          },
        ],
      },
    },
    {
      $lookup: {
        from: 'requests',
        let: { requestId: '$requestId', organizationId: '$organizationId' },
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
          { $project: { departmentId: 1, status: 1, currentSequence: 1 } },
        ],
        as: 'request',
      },
    },
    { $unwind: '$request' },
    {
      $project: {
        requestId: 1,
        attemptNumber: 1,
        stageId: 1,
        sequence: 1,
        status: 1,
        approverId: 1,
        claimedBy: 1,
        claimExpiresAt: 1,
        decidedBy: 1,
        decisionAt: 1,
        slaStartedAt: 1,
        request: 1,
      },
    },
  ]);
  const valid = steps.filter((step) =>
    hasEffectivePermission(access, 'requests.approve', step.request.departmentId) &&
    (String(step.approverId) === String(userId) ||
      String(step.decidedBy) === String(userId) ||
      delegated(delegations, step, now))
  );
  const workloadRequestIds = [...new Set(valid
    .filter((step) => ['ACTIVE', 'CLAIMED'].includes(step.status))
    .map((step) => step.requestId))];
  const attempts = workloadRequestIds.length
    ? await ApprovalStep.aggregate([
      {
        $match: {
          organizationId: oid(organizationId),
          requestId: { $in: workloadRequestIds },
        },
      },
      { $group: { _id: '$requestId', attemptNumber: { $max: '$attemptNumber' } } },
    ])
    : [];
  const currentAttempt = new Map(attempts.map((item) => [String(item._id), item.attemptNumber]));
  const claims = workloadRequestIds.length
    ? await ApprovalStep.aggregate([
      {
        $match: {
          organizationId: oid(organizationId),
          requestId: { $in: workloadRequestIds },
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
  const claimedByOther = new Set(claims
    .filter(({ _id, claimedBy }) =>
      Number(_id.attemptNumber) === Number(currentAttempt.get(String(_id.requestId))) &&
      claimedBy.some((claimer) => claimer && String(claimer) !== String(userId))
    )
    .map(({ _id }) => `${_id.requestId}:${_id.attemptNumber}:${_id.sequence}`));
  const grouped = new Map();
  for (const step of valid) {
    const departmentId = String(step.request.departmentId);
    const item = grouped.get(departmentId) || {
      assignedApprovalStages: new Set(),
      pendingApprovalStages: new Set(),
      completedDecisions: [],
    };
    const key = `${step.requestId}:${step.attemptNumber}:${step.sequence}`;
    if (['ACTIVE', 'CLAIMED'].includes(step.status) &&
        step.request.status === 'PENDING_APPROVAL' &&
        step.request.currentSequence === step.sequence &&
        Number(step.attemptNumber) === Number(currentAttempt.get(String(step.requestId))) &&
        !(step.status === 'CLAIMED' && step.claimExpiresAt && step.claimExpiresAt <= now)) {
      item.assignedApprovalStages.add(key);
      if (!claimedByOther.has(key) &&
          (step.status !== 'CLAIMED' || String(step.claimedBy) === String(userId))) {
        item.pendingApprovalStages.add(key);
      }
    }
    if (['APPROVED', 'REJECTED', 'RETURNED'].includes(step.status) &&
        step.decisionAt instanceof Date &&
        step.decisionAt >= dateRange.fromDate &&
        step.decisionAt < dateRange.toDate) {
      item.completedDecisions.push({
        status: step.status,
        duration: step.slaStartedAt instanceof Date && step.decisionAt >= step.slaStartedAt
          ? (step.decisionAt.getTime() - step.slaStartedAt.getTime()) / 60_000
          : null,
      });
    }
    grouped.set(departmentId, item);
  }
  const departmentIds = new Set([
    ...(access.scopedPermissions.get('requests.approve') || []),
    ...(access.organizationPermissions.has('requests.approve')
      ? await Department.find({ organizationId, status: 'ACTIVE' }).distinct('_id').then((ids) => ids.map(String))
      : []),
  ]);
  const departments = await Department.find({
    organizationId,
    status: 'ACTIVE',
    _id: { $in: [...departmentIds].map(oid) },
  }).select('_id name').sort({ name: 1 }).lean();
  return departments.map((department) => {
    const data = grouped.get(String(department._id));
    const completed = data?.completedDecisions || [];
    const durations = completed.map((item) => item.duration).filter((value) => value !== null);
    return {
      departmentId: String(department._id),
      departmentName: department.name,
      assignedApprovalStages: data?.assignedApprovalStages.size || 0,
      pendingApprovalStages: data?.pendingApprovalStages.size || 0,
      completedDecisions: completed.length,
      averageDecisionMinutes: durations.length
        ? Number((durations.reduce((sum, value) => sum + value, 0) / durations.length).toFixed(2))
        : null,
    };
  });
};

export const getDepartmentAnalytics = async ({ userId, organizationId, access, dateRange }) => {
  const requestVisibility = hasDepartmentPermission(access, 'requests.view')
    ? await resolveRequestVisibility({ organizationId, actorId: userId, access })
    : null;
  if (requestVisibility?.canViewOrganization &&
      access.organizationPermissions.has('departments.view')) {
    return {
      scope: 'ORGANIZATION',
      departments: await departmentRequestStats({ organizationId, dateRange }),
    };
  }

  const departmentIds = new Set(access.scopedPermissions.get('departments.view') || []);
  if (hasDepartmentPermission(access, 'requests.approve')) {
    const approvalDepartments = await approvalWorkloadByDepartment({
      organizationId,
      userId,
      access,
      dateRange,
    });
    if (approvalDepartments.length) {
      return { scope: 'AUTHORIZED_APPROVAL_ASSIGNMENTS', departments: approvalDepartments };
    }
  }

  const hasDepartmentView = access.organizationPermissions.has('departments.view') || departmentIds.size > 0;
  if (hasDepartmentView && !hasDepartmentPermission(access, 'requests.view')) {
    if (access.organizationPermissions.has('departments.view')) {
      return {
        scope: 'ORGANIZATION',
        departmentDirectory: await departmentDirectoryStats({ organizationId }),
      };
    }
    return {
      scope: 'AUTHORIZED_DEPARTMENTS',
      departmentDirectory: await departmentDirectoryStats({
        organizationId,
        departmentIds: [...departmentIds],
      }),
    };
  }

  if (access.organizationPermissions.has('departments.view') && requestVisibility) {
    return {
      scope: 'AUTHORIZED_REQUEST_HISTORY',
      departments: await departmentRequestStats({
        organizationId,
        dateRange,
        visibilityFilter: getRequestVisibilityFilter({ actorId: userId, requestVisibility }),
      }),
    };
  }

  if (access.organizationPermissions.has('departments.view')) {
    throw new AppError('Organization-wide department request analytics require organization-scoped request permissions.', 403, 'FORBIDDEN');
  }
  if (!departmentIds.size || !hasDepartmentPermission(access, 'requests.view')) {
    throw new AppError('Department analytics are not allowed in the current scope.', 403, 'FORBIDDEN');
  }
  const visibilityFilter = getRequestVisibilityFilter({ actorId: userId, requestVisibility });
  const stats = await Request.aggregate([
    {
      $match: {
        organizationId: oid(organizationId),
        ...visibilityFilter,
        departmentId: { $in: [...departmentIds].map(oid) },
        createdAt: { $gte: dateRange.fromDate, $lt: dateRange.toDate },
      },
    },
    {
      $group: {
        _id: '$departmentId',
        totalRequests: { $sum: 1 },
        pendingRequests: { $sum: { $cond: [{ $in: ['$status', ['SUBMITTED', 'PENDING_APPROVAL']] }, 1, 0] } },
        approvedRequests: { $sum: { $cond: [{ $eq: ['$status', 'APPROVED'] }, 1, 0] } },
        rejectedRequests: { $sum: { $cond: [{ $eq: ['$status', 'REJECTED'] }, 1, 0] } },
        returnedRequests: { $sum: { $cond: [{ $eq: ['$status', 'RETURNED'] }, 1, 0] } },
      },
    },
  ]);
  return {
    scope: 'AUTHORIZED_REQUEST_HISTORY',
    departments: stats.map((item) => ({
      departmentId: String(item._id),
      totalRequests: item.totalRequests,
      pendingRequests: item.pendingRequests,
      approvedRequests: item.approvedRequests,
      rejectedRequests: item.rejectedRequests,
      returnedRequests: item.returnedRequests,
      averageApprovalMinutes: null,
    })),
  };
};

export default { getDepartmentAnalytics };
