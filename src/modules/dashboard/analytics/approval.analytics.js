import mongoose from 'mongoose';
import ApprovalStep from '../../../models/ApprovalStep.js';
import Request from '../../../models/Request.js';
import User from '../../../models/User.js';
import { APPROVAL_STATUSES } from '../../../config/constants.js';
import { AppError } from '../../../utils/AppError.js';
import { hasEffectivePermission } from '../../../services/authorization/permission.service.js';

const oid = (value) => new mongoose.Types.ObjectId(String(value));
const completedStatuses = ['APPROVED', 'REJECTED', 'RETURNED'];
const stageKey = (step) => `${step.requestId}:${step.attemptNumber}:${step.sequence}`;

const getActiveDelegations = async ({ organizationId, userId, now }) => {
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
  return new Map(users.map((user) => [
    String(user._id),
    user.approvalDelegations.filter((item) =>
      String(item.organizationId) === String(organizationId) &&
      String(item.delegateId) === String(userId) &&
      item.status === 'ACTIVE' &&
      item.startsAt <= now &&
      item.endsAt > now
    ),
  ]));
};

const delegationApplies = (delegations, delegatorId, departmentId, stageId, now) =>
  (delegations.get(String(delegatorId)) || []).some((delegation) =>
    (delegation.scopeType === 'ORGANIZATION' ||
      String(delegation.departmentId) === String(departmentId)) &&
    (!delegation.stageIds.length || delegation.stageIds.includes(stageId)) &&
    delegation.startsAt <= now &&
    delegation.endsAt > now
  );

const relevantSteps = async ({ organizationId, userId, dateRange, delegations }) => {
  const approverIds = [oid(userId), ...[...delegations.keys()].map(oid)];
  return ApprovalStep.aggregate([
    {
      $match: {
        organizationId: oid(organizationId),
        $or: [
          {
            approverId: { $in: approverIds },
            $or: [
              { createdAt: { $gte: dateRange.fromDate, $lt: dateRange.toDate } },
              { status: { $in: ['ACTIVE', 'CLAIMED'] } },
            ],
          },
          {
            decidedBy: oid(userId),
            decisionAt: { $gte: dateRange.fromDate, $lt: dateRange.toDate },
          },
          {
            returnedBy: oid(userId),
            returnedAt: { $gte: dateRange.fromDate, $lt: dateRange.toDate },
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
          { $project: { departmentId: 1, status: 1, currentSequence: 1, requestNumber: 1, requesterId: 1 } },
        ],
        as: 'request',
      },
    },
    { $unwind: '$request' },
    {
      $project: {
        requestId: 1,
        organizationId: 1,
        attemptNumber: 1,
        stageId: 1,
        stageName: 1,
        sequence: 1,
        status: 1,
        approverType: 1,
        approverId: 1,
        roleId: 1,
        assignmentResolution: 1,
        approvalMode: 1,
        claimedBy: 1,
        claimedAt: 1,
        claimExpiresAt: 1,
        decidedBy: 1,
        decisionAt: 1,
        returnedBy: 1,
        returnedAt: 1,
        actedOnBehalfOf: 1,
        createdAt: 1,
        slaStartedAt: 1,
        slaDueAt: 1,
        isOverdue: 1,
        request: 1,
      },
    },
  ]);
};

const filterAuthorizedSteps = ({ steps, userId, access, delegations, now }) =>
  steps.filter((step) => {
    if (!hasEffectivePermission(access, 'requests.approve', step.request.departmentId)) return false;
    const assignedToUser = String(step.approverId) === String(userId);
    const delegatedAssignment = delegationApplies(
      delegations,
      step.approverId,
      step.request.departmentId,
      step.stageId,
      now
    );
    if (step.actedOnBehalfOf && String(step.actedOnBehalfOf) !== String(userId)) {
      return delegatedAssignment;
    }
    return assignedToUser ||
      String(step.decidedBy) === String(userId) ||
      String(step.returnedBy) === String(userId) ||
      String(step.claimedBy) === String(userId) ||
      delegatedAssignment;
  });

const validDecisionAt = (step) =>
  completedStatuses.includes(step.status) &&
  Boolean(step.decidedBy) &&
  step.decisionAt instanceof Date &&
  !Number.isNaN(step.decisionAt.getTime());

const rounded = (value, places = 2) => Number(value.toFixed(places));

export const getApprovalAnalytics = async ({ userId, organizationId, access, dateRange }) => {
  if (!access.organizationPermissions.has('requests.approve') &&
      !(access.scopedPermissions.get('requests.approve')?.size || 0)) {
    throw new AppError('Permission requests.approve is required for approval analytics.', 403, 'FORBIDDEN');
  }
  const now = new Date();
  const delegations = await getActiveDelegations({ organizationId, userId, now });
  const candidates = await relevantSteps({ organizationId, userId, dateRange, delegations });
  const steps = filterAuthorizedSteps({ steps: candidates, userId, access, delegations, now });

  const statusCounts = new Map();
  const stageMap = new Map();
  const decisions = [];
  let delegatedDecisionCount = 0;
  for (const step of steps) {
    if (step.createdAt >= dateRange.fromDate && step.createdAt < dateRange.toDate) {
      statusCounts.set(step.status, (statusCounts.get(step.status) || 0) + 1);
      const key = `${step.stageId}:${step.stageName}`;
      const stage = stageMap.get(key) || {
        stageId: step.stageId,
        stageName: step.stageName,
        totalSteps: 0,
        pendingSteps: 0,
        completedSteps: 0,
        approvedSteps: 0,
        rejectedSteps: 0,
        returnedSteps: 0,
      };
      stage.totalSteps += 1;
      if (['PENDING', 'ACTIVE', 'CLAIMED'].includes(step.status)) stage.pendingSteps += 1;
      if (completedStatuses.includes(step.status)) stage.completedSteps += 1;
      if (step.status === 'APPROVED') stage.approvedSteps += 1;
      if (step.status === 'REJECTED') stage.rejectedSteps += 1;
      if (step.status === 'RETURNED') stage.returnedSteps += 1;
      stageMap.set(key, stage);
    }
    if (!validDecisionAt(step) ||
        step.decisionAt < dateRange.fromDate ||
        step.decisionAt >= dateRange.toDate) continue;
    decisions.push(step);
    if (step.actedOnBehalfOf && String(step.actedOnBehalfOf) !== String(userId)) {
      delegatedDecisionCount += 1;
    }
  }

  const approvalStatusDistribution = APPROVAL_STATUSES.map((status) => ({
    status,
    count: statusCounts.get(status) || 0,
  }));
  const decisionCounts = new Map();
  for (const step of decisions) {
    decisionCounts.set(step.status, (decisionCounts.get(step.status) || 0) + 1);
  }
  const decisionsByStatus = completedStatuses.map((status) => ({
    decision: status,
    count: decisionCounts.get(status) || 0,
  }));
  decisionsByStatus.push({ decision: 'DELEGATED', count: delegatedDecisionCount });

  const durations = decisions
    .filter((step) =>
      step.slaStartedAt instanceof Date &&
      !Number.isNaN(step.slaStartedAt.getTime()) &&
      step.decisionAt >= step.slaStartedAt
    )
    .map((step) => (step.decisionAt.getTime() - step.slaStartedAt.getTime()) / 60_000)
    .sort((left, right) => left - right);
  const dueDecisions = decisions.filter((step) =>
    step.slaDueAt instanceof Date &&
    !Number.isNaN(step.slaDueAt.getTime()) &&
    step.slaStartedAt instanceof Date &&
    !Number.isNaN(step.slaStartedAt.getTime()) &&
    step.decisionAt >= step.slaStartedAt &&
    step.slaDueAt > step.slaStartedAt
  );
  const onTime = dueDecisions.filter((step) => step.decisionAt <= step.slaDueAt).length;
  const overdue = dueDecisions.length - onTime;
  const middle = Math.floor(durations.length / 2);
  const median = durations.length === 0
    ? null
    : durations.length % 2
      ? durations[middle]
      : (durations[middle - 1] + durations[middle]) / 2;
  const workloadRequestIds = [...new Set(steps
    .filter((step) => ['ACTIVE', 'CLAIMED'].includes(step.status))
    .map((step) => step.requestId))];
  const currentAttempts = workloadRequestIds.length
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
  const currentAttemptByRequest = new Map(currentAttempts.map((item) => [String(item._id), item.attemptNumber]));
  const claimedStages = workloadRequestIds.length
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
  const otherClaimedStages = new Set(claimedStages
    .filter(({ _id, claimedBy }) =>
      Number(_id.attemptNumber) === Number(currentAttemptByRequest.get(String(_id.requestId))) &&
      claimedBy.some((claimer) => claimer && String(claimer) !== String(userId))
    )
    .map(({ _id }) => `${_id.requestId}:${_id.attemptNumber}:${_id.sequence}`));
  const currentStages = new Map();
  for (const step of steps) {
    if (!['ACTIVE', 'CLAIMED'].includes(step.status) ||
        step.request.status !== 'PENDING_APPROVAL' ||
        step.request.currentSequence !== step.sequence ||
        Number(step.attemptNumber) !== Number(currentAttemptByRequest.get(String(step.requestId))) ||
        (step.status === 'CLAIMED' && step.claimExpiresAt && step.claimExpiresAt <= now)) continue;
    const key = stageKey(step);
    const stage = currentStages.get(key) || [];
    stage.push(step);
    currentStages.set(key, stage);
  }
  let pendingApprovalStages = 0;
  let availableToClaimStages = 0;
  let currentlyOverdueStages = 0;
  for (const stageSteps of currentStages.values()) {
    const latestAttempt = Math.max(...stageSteps.map((step) => step.attemptNumber));
    const activeSteps = stageSteps.filter((step) => step.attemptNumber === latestAttempt);
    const claimOwner = activeSteps.find((step) => step.status === 'CLAIMED')?.claimedBy;
    const assignedStep = activeSteps.find((step) =>
      String(step.approverId) === String(userId) ||
      delegationApplies(delegations, step.approverId, step.request.departmentId, step.stageId, now)
    );
    if (!assignedStep || otherClaimedStages.has(stageKey(assignedStep)) ||
        (claimOwner && String(claimOwner) !== String(userId))) continue;
    pendingApprovalStages += 1;
    if (!claimOwner && assignedStep.assignmentResolution === 'CLAIM_ONE') availableToClaimStages += 1;
    if (activeSteps.some((step) => step.isOverdue)) currentlyOverdueStages += 1;
  }

  return {
    scope: 'AUTHORIZED_APPROVAL_ASSIGNMENTS',
    approvalStatusDistribution,
    decisions: decisionsByStatus,
    stages: [...stageMap.values()].sort((left, right) => left.stageName.localeCompare(right.stageName)),
    workload: {
      pendingApprovalStages: pendingApprovalStages,
      availableToClaimStages,
      currentlyOverdueStages,
    },
    performance: {
      completedDecisions: decisions.length,
      averageDecisionMinutes: durations.length
        ? rounded(durations.reduce((sum, value) => sum + value, 0) / durations.length)
        : null,
      medianDecisionMinutes: median === null ? null : rounded(median),
      slaDecisionSampleSize: dueDecisions.length,
      onTimeDecisions: onTime,
      overdueDecisions: overdue,
      slaCompliancePercentage: dueDecisions.length
        ? rounded((onTime / dueDecisions.length) * 100)
        : null,
    },
  };
};

export default { getApprovalAnalytics };
