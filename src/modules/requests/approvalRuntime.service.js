import mongoose from 'mongoose';
import ApprovalStep from '../../models/ApprovalStep.js';
import Department from '../../models/Department.js';
import Request from '../../models/Request.js';
import Role from '../../models/Role.js';
import User from '../../models/User.js';
import UserRoleAssignment from '../../models/UserRoleAssignment.js';
import WorkflowDefinition from '../../models/WorkflowDefinition.js';
import AuditLog from '../../models/AuditLog.js';
import { AppError } from '../../utils/AppError.js';
import { evaluateCondition } from './request.conditions.js';
import { hasEffectivePermission } from '../../services/authorization/permission.service.js';
import { activeDelegationFor } from './approvalDelegation.service.js';

const durationMs = (value) => {
  if (!value?.duration) return null;
  const multiplier = { MINUTES: 60_000, HOURS: 3_600_000, DAYS: 86_400_000 }[value.unit || 'HOURS'];
  return value.duration * multiplier;
};

const stageTiming = (workflow, stageId) => workflow.stages.find((stage) => stage.stageId === stageId)?.sla || null;

const audit = async (session, { organizationId, actorId, action, resourceId, changes = {} }) => {
  await AuditLog.create([{
    organizationId,
    actorId,
    action,
    resourceType: 'Approval',
    resourceId,
    changes,
    timestamp: new Date(),
  }], { session });
};

const workflowForRequest = async ({ organizationId, requestTypeId, workflowDefinitionId, workflowVersion, session }) => {
  if (workflowDefinitionId) {
    const snapshot = await WorkflowDefinition.findOne({
      _id: workflowDefinitionId,
      organizationId,
      definitionType: 'APPROVAL_WORKFLOW',
      version: workflowVersion,
    }).session(session);
    if (!snapshot) throw new AppError('The approval workflow snapshot is unavailable.', 409, 'WORKFLOW_NOT_FOUND');
    return snapshot;
  }
  const exact = await WorkflowDefinition.findOne({
    organizationId, definitionType: 'APPROVAL_WORKFLOW', requestTypeId, isActive: true,
  }).session(session);
  if (exact) return exact;
  const fallback = await WorkflowDefinition.findOne({
    organizationId, definitionType: 'APPROVAL_WORKFLOW', isDefault: true, isActive: true,
  }).session(session);
  if (!fallback) throw new AppError('No active approval workflow is configured for this organization.', 409, 'WORKFLOW_NOT_FOUND');
  return fallback;
};

const activeUsers = async ({ organizationId, userIds, session }) => {
  if (!userIds.length) return [];
  return User.find({
    _id: { $in: userIds },
    accountStatus: 'ACTIVE',
    organizationMemberships: { $elemMatch: { organizationId, status: 'ACTIVE' } },
  }).select('_id').session(session);
};

const assignmentsForUsers = async ({ organizationId, userIds, roleType, roleId, departmentId, session }) => {
  const roleFilter = roleId ? { _id: roleId } : { roleType };
  const roles = await Role.find({ organizationId, status: 'ACTIVE', ...roleFilter }).select('_id roleType').session(session);
  const roleIds = roles.map((role) => role._id);
  if (!roleIds.length) return [];
  const assignments = await UserRoleAssignment.find({
    organizationId,
    userId: { $in: userIds },
    roleId: { $in: roleIds },
    status: 'ACTIVE',
    ...(departmentId ? { $or: [{ scopeType: 'ORGANIZATION', departmentId: null }, { scopeType: 'DEPARTMENT', departmentId }] } : {}),
  }).select('userId roleId').session(session);
  const eligible = await activeUsers({ organizationId, userIds: assignments.map((item) => item.userId), session });
  return eligible.map((user) => user._id);
};

const resolveApprovers = async ({ organizationId, request, stage, session }) => {
  const assignment = stage.assignment || {};
  if (stage.approverType === 'DEPARTMENT_MANAGER') {
    const department = await Department.findOne({
      _id: request.departmentId, organizationId, status: 'ACTIVE',
    }).select('managerIds').session(session);
    if (!department) throw new AppError('The request department is unavailable.', 409, 'DEPARTMENT_NOT_FOUND');
    return assignmentsForUsers({
      organizationId,
      userIds: department.managerIds.filter((id) => String(id) !== String(request.requesterId)),
      roleType: 'DEPARTMENT_MANAGER',
      departmentId: request.departmentId,
      session,
    });
  }
  if (stage.approverType === 'ROLE') {
    return assignmentsForUsers({
      organizationId,
      userIds: await User.find({
        organizationMemberships: { $elemMatch: { organizationId, status: 'ACTIVE' } },
        accountStatus: 'ACTIVE',
      }).distinct('_id').session(session),
      roleId: assignment.roleId || stage.roleId,
      departmentId: request.departmentId,
      session,
    });
  }
  if (stage.approverType === 'USER') {
    const eligible = await activeUsers({ organizationId, userIds: [assignment.userId], session });
    return eligible.filter((id) => String(id) !== String(request.requesterId));
  }
  if (stage.approverType === 'ORGANIZATION_ADMIN') {
    const userIds = await UserRoleAssignment.find({
      organizationId, status: 'ACTIVE', scopeType: 'ORGANIZATION', departmentId: null,
    }).distinct('userId').session(session);
    return assignmentsForUsers({
      organizationId,
      userIds: userIds.filter((id) => String(id) !== String(request.requesterId)),
      roleType: 'ORGANIZATION_ADMIN',
      session,
    });
  }
  return [];
};

const stageApplicable = (stage, request) =>
  !stage.condition || evaluateCondition(stage.condition, { ...(request.details || {}), amount: request.amount });

export const createRuntimeApprovals = async ({
  organizationId, request, session, actorId, attemptNumber = 1, workflowDefinitionId = null, workflowVersion = null,
}) => {
  const workflow = await workflowForRequest({
    organizationId,
    requestTypeId: request.requestTypeId,
    workflowDefinitionId,
    workflowVersion,
    session,
  });
  const existing = await ApprovalStep.exists({ requestId: request._id, attemptNumber }).session(session);
  if (existing) throw new AppError('Approval steps already exist for this request.', 409, 'APPROVAL_ALREADY_CREATED');

  const records = [];
  const stages = [...workflow.stages].sort((a, b) => a.sequence - b.sequence);
  let firstApplicable = true;
  for (const stage of stages) {
    if (!stageApplicable(stage, request)) {
      records.push({
        organizationId, requestId: request._id, attemptNumber,
        workflowDefinitionId: workflow._id, workflowVersion: workflow.version,
        stageId: stage.stageId, sequence: stage.sequence, stageName: stage.name,
        approverType: stage.approverType, assignmentResolution: stage.assignment?.resolution || 'DIRECT',
        approvalMode: stage.approvalMode, status: 'SKIPPED',
      });
      continue;
    }
    const approvers = await resolveApprovers({ organizationId, request, stage, session });
    if (!approvers.length) throw new AppError(`No eligible approver is available for ${stage.name}.`, 409, 'NO_ELIGIBLE_APPROVER');
    const stageStartedAt = firstApplicable ? new Date() : null;
    const stageDuration = stageStartedAt && stage.sla ? durationMs(stage.sla) : null;
    const firstReminderAt = stageStartedAt && stage.sla?.reminders?.[0]
      ? new Date(stageStartedAt.getTime() + durationMs({
        duration: stage.sla.reminders[0].after,
        unit: stage.sla.reminders[0].unit,
      }))
      : null;
    for (const approverId of approvers) {
      records.push({
        organizationId, requestId: request._id, attemptNumber,
        workflowDefinitionId: workflow._id, workflowVersion: workflow.version,
        stageId: stage.stageId, sequence: stage.sequence, stageName: stage.name,
        approverType: stage.approverType, approverId,
        roleId: stage.assignment?.roleId || stage.roleId || null,
        assignmentResolution: stage.assignment?.resolution || 'DIRECT',
        approvalMode: stage.approvalMode,
        ...(stageDuration
          ? {
            slaStartedAt: stageStartedAt,
            slaDueAt: new Date(stageStartedAt.getTime() + stageDuration),
            nextReminderAt: firstReminderAt,
          }
          : {}),
        status: firstApplicable ? 'ACTIVE' : 'PENDING',
      });
    }
    firstApplicable = false;
  }
  if (!records.some((record) => ['ACTIVE', 'PENDING'].includes(record.status))) {
    throw new AppError('The approval workflow has no applicable stages.', 409, 'NO_APPLICABLE_APPROVAL_STAGE');
  }
  await ApprovalStep.insertMany(records, { session });
  request.workflowDefinitionId = workflow._id;
  request.currentSequence = records.find((record) => record.status === 'ACTIVE')?.sequence || 0;
  request.status = 'PENDING_APPROVAL';
  await request.save({ session });
  await audit(session, {
    organizationId, actorId, action: 'APPROVAL_STAGES_CREATED', resourceId: request._id,
    changes: {
      workflowDefinitionId: String(workflow._id),
      workflowVersion: workflow.version,
      attemptNumber,
      count: records.length,
    },
  });
  return workflow;
};

const getActionContext = async ({ organizationId, approvalStepId, actorId, access, session }) => {
  const step = await ApprovalStep.findOne({ _id: approvalStepId, organizationId }).session(session);
  if (!step) throw new AppError('Approval step not found.', 404, 'APPROVAL_NOT_FOUND');
  const request = await Request.findOne({ _id: step.requestId, organizationId }).session(session);
  if (!request) throw new AppError('Request not found.', 404, 'REQUEST_NOT_FOUND');
  if (request.status !== 'PENDING_APPROVAL') throw new AppError('This request is not awaiting approval.', 409, 'INVALID_REQUEST_STATUS');
  if (String(request.requesterId) === String(actorId)) {
    throw new AppError('Requesters cannot approve their own requests.', 403, 'SELF_APPROVAL_FORBIDDEN');
  }
  if (!hasEffectivePermission(access, 'requests.approve', request.departmentId)) {
    throw new AppError('Permission requests.approve is required for this operation.', 403, 'FORBIDDEN');
  }
  if (step.assignmentResolution === 'CLAIM_ONE' && step.claimedBy &&
      String(step.claimedBy) !== String(actorId)) {
    throw new AppError('This approval is claimed by another approver.', 409, 'APPROVAL_CLAIMED');
  }
  if (!['ACTIVE', 'CLAIMED'].includes(step.status)) throw new AppError('This approval step is no longer actionable.', 409, 'APPROVAL_NOT_ACTIONABLE');
  if (step.status === 'CLAIMED' && step.claimExpiresAt && step.claimExpiresAt <= new Date()) {
    throw new AppError('This approval claim has expired.', 409, 'APPROVAL_CLAIM_EXPIRED');
  }
  if (step.assignmentResolution === 'CLAIM_ONE') {
    const activeClaim = await ApprovalStep.exists({
      organizationId,
      requestId: step.requestId,
      attemptNumber: step.attemptNumber,
      sequence: step.sequence,
      status: 'CLAIMED',
      _id: { $ne: step._id },
    }).session(session);
    if (activeClaim) throw new AppError('This approval is claimed by another approver.', 409, 'APPROVAL_CLAIMED');
  }
  let delegation = null;
  if (String(step.approverId) !== String(actorId)) {
    delegation = await activeDelegationFor({
      organizationId,
      delegatorId: step.approverId,
      delegateId: actorId,
      departmentId: request.departmentId,
      stageId: step.stageId,
    });
    if (!delegation) throw new AppError('You are not eligible for this approval.', 403, 'FORBIDDEN');
  }
  const workflow = await WorkflowDefinition.findOne({
    _id: step.workflowDefinitionId,
    organizationId,
    version: step.workflowVersion,
  }).select('stages').session(session);
  return { step, request, delegation, workflowStage: workflow?.stages.find((stage) => stage.stageId === step.stageId) };
};

export const claimApproval = async ({ organizationId, approvalStepId, actorId, access, session }) => {
  const context = await getActionContext({ organizationId, approvalStepId, actorId, access, session });
  if (context.step.assignmentResolution !== 'CLAIM_ONE') {
    throw new AppError('This approval does not support claiming.', 409, 'APPROVAL_NOT_CLAIMABLE');
  }
  const step = await ApprovalStep.findOneAndUpdate({
    _id: approvalStepId, organizationId, approverId: context.step.approverId, status: 'ACTIVE',
    assignmentResolution: 'CLAIM_ONE', claimedBy: null,
  }, { $set: {
    status: 'CLAIMED',
    claimedBy: actorId,
    claimedAt: new Date(),
    ...(context.delegation ? { delegationId: context.delegation._id, actedOnBehalfOf: context.step.approverId } : {}),
    claimExpiresAt: (() => {
      const timing = context.workflowStage?.sla?.claimExpiry;
      return timing?.duration ? new Date(Date.now() + durationMs(timing)) : null;
    })(),
  } }, { new: true, session });
  if (!step) throw new AppError('Approval is already claimed or unavailable.', 409, 'APPROVAL_CLAIMED');
  await ApprovalStep.updateMany({
    organizationId,
    requestId: step.requestId,
    attemptNumber: step.attemptNumber,
    sequence: step.sequence,
    _id: { $ne: step._id },
    status: 'ACTIVE',
    claimedBy: null,
  }, { $set: {
    status: 'CANCELLED',
    claimedBy: actorId,
    claimedAt: step.claimedAt,
    claimExpiresAt: step.claimExpiresAt,
  } }, { session });
  await audit(session, { organizationId, actorId, action: 'APPROVAL_CLAIMED', resourceId: step._id });
  return step;
};

const advanceStage = async ({ organizationId, request, sequence, attemptNumber, session, actorId }) => {
  const current = await ApprovalStep.find({ organizationId, requestId: request._id, attemptNumber, sequence }).session(session);
  const representative = current[0];
  const complete = representative.approvalMode === 'ALL'
    ? current.every((item) => item.status === 'APPROVED')
    : current.some((item) => item.status === 'APPROVED');
  if (!complete) return;
  if (representative.approvalMode === 'ANY') {
    await ApprovalStep.updateMany({
      organizationId, requestId: request._id, attemptNumber, sequence,
      status: { $in: ['ACTIVE', 'CLAIMED', 'PENDING'] },
    }, { $set: { status: 'CANCELLED' } }, { session });
  }
  const workflow = await WorkflowDefinition.findOne({
    _id: current[0].workflowDefinitionId,
    organizationId,
    version: current[0].workflowVersion,
  }).select('stages').session(session);
  const nextSteps = await ApprovalStep.find({
    organizationId, requestId: request._id, attemptNumber, sequence: { $gt: sequence }, status: 'PENDING',
  }).sort({ sequence: 1 }).session(session);
  const nextSequence = nextSteps[0]?.sequence;
  if (nextSequence) {
    const stage = workflow?.stages.find((item) => item.sequence === nextSequence);
    const startedAt = new Date();
    const timing = stage?.sla;
    const dueAt = timing?.duration ? new Date(startedAt.getTime() + durationMs(timing)) : null;
    const firstReminder = timing?.reminders?.[0];
    const nextReminderAt = firstReminder
      ? new Date(startedAt.getTime() + durationMs({ duration: firstReminder.after, unit: firstReminder.unit }))
      : null;
    await ApprovalStep.updateMany({
      organizationId, requestId: request._id, attemptNumber, sequence: nextSequence, status: 'PENDING',
    }, { $set: { status: 'ACTIVE', slaStartedAt: startedAt, slaDueAt: dueAt, nextReminderAt } }, { session });
  }
  const next = await ApprovalStep.findOne({
    organizationId, requestId: request._id, attemptNumber, status: 'ACTIVE',
  }).sort({ sequence: 1 }).session(session);
  if (next) {
    request.currentSequence = next.sequence;
    await request.save({ session });
    await audit(session, { organizationId, actorId, action: 'APPROVAL_STAGE_ACTIVATED', resourceId: next._id, changes: { sequence: next.sequence } });
  } else {
    request.status = 'APPROVED';
    request.currentSequence = 0;
    await request.save({ session });
    await audit(session, { organizationId, actorId, action: 'REQUEST_APPROVED', resourceId: request._id });
  }
};

export const approveApproval = async ({ organizationId, approvalStepId, actorId, access, comment, session }) => {
  const { step, request, delegation } = await getActionContext({ organizationId, approvalStepId, actorId, access, session });
  if (step.assignmentResolution === 'CLAIM_ONE' &&
      (step.status !== 'CLAIMED' || String(step.claimedBy) !== String(actorId))) {
    throw new AppError('Claim this approval before acting on it.', 409, 'APPROVAL_CLAIM_REQUIRED');
  }
  const updated = await ApprovalStep.findOneAndUpdate({
    _id: step._id,
    status: step.assignmentResolution === 'CLAIM_ONE' ? 'CLAIMED' : { $in: ['ACTIVE', 'CLAIMED'] },
    ...(step.assignmentResolution === 'CLAIM_ONE' ? { claimedBy: actorId } : {}),
  }, { $set: {
    status: 'APPROVED',
    decidedBy: actorId,
    decisionAt: new Date(),
    comments: comment || '',
    ...(delegation ? { actedOnBehalfOf: step.approverId, delegationId: delegation._id } : {}),
  } }, { new: true, session });
  if (!updated) throw new AppError('Approval was completed by another action.', 409, 'APPROVAL_ALREADY_COMPLETED');
  await audit(session, { organizationId, actorId, action: 'APPROVAL_GRANTED', resourceId: updated._id, changes: { comment: comment || '' } });
  await advanceStage({
    organizationId,
    request,
    sequence: updated.sequence,
    attemptNumber: updated.attemptNumber,
    session,
    actorId,
  });
  return updated;
};

export const rejectApproval = async ({ organizationId, approvalStepId, actorId, access, comment, session }) => {
  const { step, request, delegation } = await getActionContext({ organizationId, approvalStepId, actorId, access, session });
  if (step.assignmentResolution === 'CLAIM_ONE' &&
      (step.status !== 'CLAIMED' || String(step.claimedBy) !== String(actorId))) {
    throw new AppError('Claim this approval before acting on it.', 409, 'APPROVAL_CLAIM_REQUIRED');
  }
  const updated = await ApprovalStep.findOneAndUpdate({
    _id: step._id,
    status: step.assignmentResolution === 'CLAIM_ONE' ? 'CLAIMED' : { $in: ['ACTIVE', 'CLAIMED'] },
    ...(step.assignmentResolution === 'CLAIM_ONE' ? { claimedBy: actorId } : {}),
  }, { $set: {
    status: 'REJECTED',
    decidedBy: actorId,
    decisionAt: new Date(),
    comments: comment || '',
    ...(delegation ? { actedOnBehalfOf: step.approverId, delegationId: delegation._id } : {}),
  } }, { new: true, session });
  if (!updated) throw new AppError('Approval was completed by another action.', 409, 'APPROVAL_ALREADY_COMPLETED');
  await ApprovalStep.updateMany({
    organizationId, requestId: request._id, attemptNumber: step.attemptNumber, status: { $in: ['ACTIVE', 'PENDING'] },
  }, { $set: { status: 'CANCELLED' } }, { session });
  request.status = 'REJECTED';
  request.currentSequence = 0;
  await request.save({ session });
  await audit(session, { organizationId, actorId, action: 'APPROVAL_REJECTED', resourceId: updated._id, changes: { comment: comment || '' } });
  return updated;
};

export const returnApproval = async ({ organizationId, approvalStepId, actorId, access, reason, session }) => {
  const { step, request, delegation } = await getActionContext({ organizationId, approvalStepId, actorId, access, session });
  if (step.assignmentResolution === 'CLAIM_ONE' &&
      (step.status !== 'CLAIMED' || String(step.claimedBy) !== String(actorId))) {
    throw new AppError('Claim this approval before acting on it.', 409, 'APPROVAL_CLAIM_REQUIRED');
  }
  const updated = await ApprovalStep.findOneAndUpdate({
    _id: step._id,
    organizationId,
    status: step.assignmentResolution === 'CLAIM_ONE' ? 'CLAIMED' : { $in: ['ACTIVE', 'CLAIMED'] },
    ...(step.assignmentResolution === 'CLAIM_ONE' ? { claimedBy: actorId } : {}),
  }, {
    $set: {
      status: 'RETURNED',
      decidedBy: actorId,
      decisionAt: new Date(),
      returnedBy: actorId,
      returnedAt: new Date(),
      comments: reason,
      ...(delegation ? { actedOnBehalfOf: step.approverId, delegationId: delegation._id } : {}),
    },
  }, { new: true, session });
  if (!updated) throw new AppError('Approval was completed by another action.', 409, 'APPROVAL_ALREADY_COMPLETED');
  await ApprovalStep.updateMany({
    organizationId,
    requestId: request._id,
    attemptNumber: step.attemptNumber,
    status: { $in: ['ACTIVE', 'PENDING', 'CLAIMED'] },
  }, { $set: { status: 'CANCELLED' } }, { session });
  request.status = 'RETURNED';
  request.currentSequence = 0;
  request.returnedAt = updated.returnedAt;
  request.returnedBy = actorId;
  request.returnReason = reason;
  await request.save({ session });
  await audit(session, {
    organizationId,
    actorId,
    action: 'REQUEST_RETURNED',
    resourceId: request._id,
    changes: { approvalStepId: String(updated._id), reason },
  });
  return updated;
};

export const cancelPendingApprovals = async ({ organizationId, requestId, session, actorId }) => {
  await ApprovalStep.updateMany({
    organizationId, requestId, status: { $in: ['ACTIVE', 'PENDING', 'CLAIMED'] },
  }, { $set: { status: 'CANCELLED' } }, { session });
  await audit(session, { organizationId, actorId, action: 'APPROVAL_CANCELLED', resourceId: requestId });
};

export const getApprovalStep = async ({ organizationId, approvalStepId }) => {
  const step = await ApprovalStep.findOne({ _id: approvalStepId, organizationId });
  if (!step) throw new AppError('Approval step not found.', 404, 'APPROVAL_NOT_FOUND');
  return step;
};

const approvalVisibilityFilter = ({ organizationId, actorId, approverIds, query }) => {
  const filter = { organizationId, approverId: { $in: approverIds } };
  if (query.status) filter.status = query.status;
  if (query.requestId) filter.requestId = query.requestId;
  if (query.approvalMode) filter.approvalMode = query.approvalMode;
  if (query.stageId) filter.stageId = query.stageId;
  if (query.category === 'available' || query.category === 'pending_action') {
    filter.status = { $in: ['ACTIVE'] };
    filter.claimedBy = null;
  } else if (query.category === 'assigned') {
    filter.status = { $in: ['CLAIMED'] };
    filter.claimedBy = actorId;
  } else if (query.category === 'completed') {
    filter.status = { $in: ['APPROVED', 'REJECTED', 'RETURNED'] };
    filter.decidedBy = actorId;
  } else if (query.category === 'all') {
    filter.$or = [
      { status: 'ACTIVE', claimedBy: null },
      { status: 'PENDING', claimedBy: null },
      { status: 'CLAIMED', claimedBy: actorId },
      { decidedBy: actorId },
    ];
  } else {
    filter.$or = [
      { status: { $in: ['ACTIVE', 'PENDING'] }, claimedBy: null },
      { status: 'CLAIMED', claimedBy: actorId },
      { decidedBy: actorId },
    ];
  }
  return filter;
};

const enrichApprovalSteps = async (steps) => {
  const requestIds = [...new Set(steps.map((step) => String(step.requestId)))];
  const requests = await Request.find({ _id: { $in: requestIds } })
    .select('requestNumber requestTypeId requestTypeName title requesterId departmentId status currentSequence submittedAt')
    .lean();
  const requestMap = new Map(requests.map((request) => [String(request._id), request]));
  return steps.map((step) => ({ ...step, request: requestMap.get(String(step.requestId)) || null }));
};

export const listApprovalInbox = async ({ organizationId, actorId, access, query }) => {
  if (!access.organizationPermissions.has('requests.approve') &&
      !(access.scopedPermissions.get('requests.approve')?.size || 0)) {
    throw new AppError('Permission requests.approve is required for this operation.', 403, 'FORBIDDEN');
  }
  const delegators = await User.find({
    accountStatus: 'ACTIVE',
    organizationMemberships: { $elemMatch: { organizationId, status: 'ACTIVE' } },
    approvalDelegations: {
      $elemMatch: {
        organizationId,
        delegateId: actorId,
        status: 'ACTIVE',
        startsAt: { $lte: new Date() },
        endsAt: { $gt: new Date() },
      },
    },
  }).select('_id approvalDelegations');
  const delegatorIds = delegators.map((user) => user._id);
  const filter = approvalVisibilityFilter({ organizationId, actorId, approverIds: [actorId, ...delegatorIds], query });
  const requestFilter = { organizationId };
  if (query.requestNumber) requestFilter.requestNumber = query.requestNumber;
  if (query.requestTypeId) requestFilter.requestTypeId = query.requestTypeId;
  if (query.departmentId) requestFilter.departmentId = query.departmentId;
  if (query.requesterId) requestFilter.requesterId = query.requesterId;
  if (query.fromDate || query.toDate) {
    requestFilter.createdAt = {};
    if (query.fromDate) requestFilter.createdAt.$gte = new Date(query.fromDate);
    if (query.toDate) requestFilter.createdAt.$lte = new Date(query.toDate);
  }
  const matchingRequests = await Request.find(requestFilter).distinct('_id');
  if (query.requestNumber || query.requestTypeId || query.departmentId || query.requesterId || query.fromDate || query.toDate) {
    filter.requestId = { $in: matchingRequests };
  }
  const sort = { [query.sortBy]: query.sortOrder === 'asc' ? 1 : -1, _id: 1 };
  const candidates = await ApprovalStep.find(filter).sort(sort).lean();
  const enriched = await enrichApprovalSteps(candidates);
  const activeRequestIds = [...new Set(enriched
    .filter((step) => ['ACTIVE', 'CLAIMED'].includes(step.status) && step.request?.status === 'PENDING_APPROVAL')
    .map((step) => step.requestId))];
  const currentAttempts = await ApprovalStep.aggregate([
    { $match: { organizationId: new mongoose.Types.ObjectId(organizationId), requestId: { $in: activeRequestIds } } },
    { $group: { _id: '$requestId', attemptNumber: { $max: '$attemptNumber' } } },
  ]);
  const currentAttemptMap = new Map(currentAttempts.map((item) => [String(item._id), item.attemptNumber]));
  const items = [];
  for (const step of enriched) {
    if (!step.request) continue;
    const departmentId = step.request.departmentId;
    if (['ACTIVE', 'CLAIMED'].includes(step.status) &&
        (step.request.status !== 'PENDING_APPROVAL' ||
         step.request.currentSequence !== step.sequence ||
         currentAttemptMap.get(String(step.requestId)) !== step.attemptNumber)) continue;
    const hasPermission = hasEffectivePermission(access, 'requests.approve', departmentId);
    const isAssignedApprover = String(step.approverId) === String(actorId);
    if (isAssignedApprover && hasPermission) {
      items.push(step);
      continue;
    }
    if (!delegatorIds.some((id) => String(id) === String(step.approverId)) || !hasPermission) continue;
    const delegation = await activeDelegationFor({
      organizationId,
      delegatorId: step.approverId,
      delegateId: actorId,
      departmentId,
      stageId: step.stageId,
    });
    if (delegation) items.push(step);
  }
  const total = items.length;
  const pageItems = items.slice((query.page - 1) * query.limit, query.page * query.limit);
  return {
    items: pageItems,
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: total ? Math.ceil(total / query.limit) : 0,
    },
  };
};

export const getApprovalDetails = async ({ organizationId, actorId, access, approvalStepId }) => {
  const step = await ApprovalStep.findOne({ _id: approvalStepId, organizationId }).lean();
  if (!step) {
    throw new AppError('Approval step not found.', 404, 'APPROVAL_NOT_FOUND');
  }
  const request = await Request.findOne({ _id: step.requestId, organizationId })
    .select('-__v')
    .populate({ path: 'requesterId', select: 'name email' })
    .populate({ path: 'departmentId', select: 'name status' })
    .lean();
  if (!request) throw new AppError('Request not found.', 404, 'REQUEST_NOT_FOUND');

  const requestDepartmentId = request.departmentId?._id || request.departmentId;
  const hasApprovalPermission = hasEffectivePermission(access, 'requests.approve', requestDepartmentId);
  const isOriginalApprover = String(step.approverId) === String(actorId);
  const delegatedAccess = !isOriginalApprover ? await activeDelegationFor({
    organizationId,
    delegatorId: step.approverId,
    delegateId: actorId,
    departmentId: requestDepartmentId,
    stageId: step.stageId,
  }) : null;

  if ((step.claimedBy && String(step.claimedBy) !== String(actorId) &&
      !['APPROVED', 'REJECTED', 'RETURNED'].includes(step.status)) ||
      (!isOriginalApprover && !delegatedAccess) ||
      !hasApprovalPermission) {
    throw new AppError('Approval step not found.', 404, 'APPROVAL_NOT_FOUND');
  }

  const workflow = await WorkflowDefinition.findOne({
    _id: step.workflowDefinitionId,
    organizationId,
    version: step.workflowVersion,
  }).select('name version stages').lean();
  const historySteps = await ApprovalStep.find({ organizationId, requestId: step.requestId })
    .sort({ attemptNumber: 1, sequence: 1, createdAt: 1 })
    .select('attemptNumber stageId stageName sequence status approverId assignmentResolution claimedBy claimedAt decidedBy decisionAt comments returnedBy returnedAt')
    .lean();
  const history = [];
  const claimOneStages = new Map();
  for (const historyStep of historySteps) {
    if (historyStep.assignmentResolution !== 'CLAIM_ONE') {
      history.push(historyStep);
      continue;
    }
    const key = `${historyStep.attemptNumber}:${historyStep.sequence}:${historyStep.stageId}`;
    const stage = claimOneStages.get(key) || { ...historyStep, approverIds: [] };
    if (historyStep.approverId && !stage.approverIds.some((id) => String(id) === String(historyStep.approverId))) {
      stage.approverIds.push(historyStep.approverId);
    }
    if (historyStep.status === 'CLAIMED' || (!stage.claimedAt && historyStep.claimedAt)) {
      Object.assign(stage, historyStep, { approverIds: stage.approverIds });
    }
    claimOneStages.set(key, stage);
  }
  history.push(...claimOneStages.values());
  history.sort((left, right) =>
    left.attemptNumber - right.attemptNumber ||
    left.sequence - right.sequence ||
    String(left.stageId).localeCompare(String(right.stageId))
  );
  return { approval: step, request, workflow, history };
};
