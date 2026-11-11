import ApprovalStep from '../../models/ApprovalStep.js';
import Request from '../../models/Request.js';
import User from '../../models/User.js';
import { hasEffectivePermission, resolveEffectivePermissions } from '../authorization/permission.service.js';
import { sendApprovalNotification } from './approvalNotification.service.js';

const activeRecipient = async ({ organizationId, userId }) => User.findOne({
  _id: userId,
  accountStatus: 'ACTIVE',
  organizationMemberships: { $elemMatch: { organizationId, status: 'ACTIVE' } },
}).select('_id name email').lean();

const notifyUser = async ({ organizationId, userId, event, request, step }) => {
  const recipient = await activeRecipient({ organizationId, userId });
  if (!recipient?.email) return false;
  try {
    await sendApprovalNotification({
      recipient,
      event,
      subject: `AccessFlow ${event}: ${request?.requestNumber || 'approval workflow'}`,
      request,
      step,
    });
    return true;
  } catch (error) {
    console.warn(`Approval lifecycle notification failed for ${event}:`, error.message);
    return false;
  }
};

const currentDelegates = async ({ request, step, now = new Date() }) => {
  const delegator = await User.findOne({
    _id: step.approverId,
    accountStatus: 'ACTIVE',
    organizationMemberships: { $elemMatch: { organizationId: request.organizationId, status: 'ACTIVE' } },
  }).select('approvalDelegations').lean();
  const eligible = [];
  for (const delegation of delegator?.approvalDelegations || []) {
    if (String(delegation.organizationId) !== String(request.organizationId) ||
        delegation.status !== 'ACTIVE' ||
        new Date(delegation.startsAt) > now ||
        new Date(delegation.endsAt) <= now ||
        (delegation.scopeType === 'DEPARTMENT' && String(delegation.departmentId) !== String(request.departmentId)) ||
        (delegation.stageIds?.length && !delegation.stageIds.includes(step.stageId))) continue;
    const delegate = await activeRecipient({ organizationId: request.organizationId, userId: delegation.delegateId });
    if (!delegate) continue;
    const access = await resolveEffectivePermissions({ userId: delegate._id, organizationId: request.organizationId });
    if (hasEffectivePermission(access, 'requests.approve', request.departmentId)) eligible.push(delegate._id);
  }
  return eligible;
};

const notifyStepAssignees = async ({ request, step, event = 'assigned' }) => {
  const recipientIds = new Set([String(step.approverId), ...(await currentDelegates({ request, step })).map(String)]);
  await Promise.all([...recipientIds].map((userId) => notifyUser({
    organizationId: request.organizationId,
    userId,
    event,
    request,
    step,
  })));
};

export const notifyApprovalStepAssignees = async ({ organizationId, requestId, stepId, event }) => {
  const [request, step] = await Promise.all([
    Request.findOne({ _id: requestId, organizationId }).lean(),
    ApprovalStep.findOne({ _id: stepId, requestId, organizationId }).lean(),
  ]);
  if (request && step) await notifyStepAssignees({ request, step, event });
};

export const notifyRequestSubmission = async ({ organizationId, requestId, event = 'request_submitted' }) => {
  const request = await Request.findOne({ _id: requestId, organizationId }).lean();
  if (!request) return;
  const latestAttempt = await ApprovalStep.findOne({ organizationId, requestId })
    .sort({ attemptNumber: -1 })
    .select('attemptNumber')
    .lean();
  const latest = latestAttempt && await ApprovalStep.findOne({
    organizationId,
    requestId,
    attemptNumber: latestAttempt.attemptNumber,
  }).sort({ sequence: 1 }).lean();
  await notifyUser({ organizationId, userId: request.requesterId, event, request, step: latest });
  const active = await ApprovalStep.find({
    organizationId,
    requestId,
    attemptNumber: latest?.attemptNumber,
    status: 'ACTIVE',
  }).lean();
  await Promise.all(active.map((step) => notifyStepAssignees({ request, step })));
};

export const notifyApprovalAction = async ({ organizationId, stepId, event }) => {
  const step = await ApprovalStep.findOne({ _id: stepId, organizationId }).lean();
  if (!step) return;
  const request = await Request.findOne({ _id: step.requestId, organizationId }).lean();
  if (!request) return;
  await notifyUser({ organizationId, userId: request.requesterId, event, request, step });

  const actingUserId = step.decidedBy || step.claimedBy;
  if (step.actedOnBehalfOf && actingUserId && String(step.actedOnBehalfOf) !== String(actingUserId)) {
    await notifyUser({ organizationId, userId: step.actedOnBehalfOf, event: 'delegated_action', request, step });
  }

  if (event === 'approved' && request.status === 'APPROVED') {
    await notifyUser({ organizationId, userId: request.requesterId, event: 'request_approved', request, step });
  }
  if (event === 'approved' && request.status === 'PENDING_APPROVAL') {
    const active = await ApprovalStep.find({
      organizationId,
      requestId: request._id,
      attemptNumber: step.attemptNumber,
      status: 'ACTIVE',
      sequence: { $gt: step.sequence },
    }).lean();
    await Promise.all(active.map((nextStep) => notifyStepAssignees({ request, step: nextStep })));
  }
};

export const notifyRequestCancellation = async ({ organizationId, requestId }) => {
  const request = await Request.findOne({ _id: requestId, organizationId }).lean();
  if (!request) return;
  const latestAttempt = await ApprovalStep.findOne({ organizationId, requestId }).sort({ attemptNumber: -1 }).select('attemptNumber').lean();
  const currentSteps = request.currentSequence
    ? await ApprovalStep.find({
      organizationId,
      requestId,
      attemptNumber: latestAttempt?.attemptNumber,
      sequence: request.currentSequence,
    }).lean()
    : [];
  await notifyUser({ organizationId, userId: request.requesterId, event: 'cancelled', request, step: currentSteps[0] });
  await Promise.all(currentSteps.map((step) => notifyStepAssignees({ request, step, event: 'cancelled' })));
};

export const notifyDelegationChange = async ({ organizationId, delegation, event }) => {
  const recipientIds = new Set([String(delegation.delegatorId), String(delegation.delegateId)]);
  await Promise.all([...recipientIds].map((userId) => notifyUser({
    organizationId,
    userId,
    event,
    request: null,
    step: null,
  })));
};

export const notifyApprovalRecipient = async ({ organizationId, userId, event, request, step }) =>
  notifyUser({ organizationId, userId, event, request, step });

export const runApprovalNotificationSafely = async (send) => {
  try {
    await send();
  } catch (error) {
    console.warn('Approval notification preparation failed:', error.message);
  }
};

export const notifyApprovalAssignees = async ({ organizationId, requestId, attemptNumber, sequence, event = 'assigned' }) => {
  const request = await Request.findOne({ _id: requestId, organizationId }).lean();
  if (!request || request.status !== 'PENDING_APPROVAL') return;
  const steps = await ApprovalStep.find({
    organizationId,
    requestId,
    attemptNumber,
    sequence,
    status: { $in: ['ACTIVE', 'CLAIMED'] },
    claimedBy: null,
  }).lean();
  await Promise.all(steps.map((step) => notifyStepAssignees({ request, step, event })));
};
