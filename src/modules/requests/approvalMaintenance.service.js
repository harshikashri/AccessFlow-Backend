import ApprovalStep from '../../models/ApprovalStep.js';
import Request from '../../models/Request.js';
import User from '../../models/User.js';
import WorkflowDefinition from '../../models/WorkflowDefinition.js';
import AuditLog from '../../models/AuditLog.js';
import Role from '../../models/Role.js';
import UserRoleAssignment from '../../models/UserRoleAssignment.js';
import { hasEffectivePermission, resolveEffectivePermissions } from '../../services/authorization/permission.service.js';
import { sendApprovalNotification } from '../../services/email/approvalNotification.service.js';
import { withTransaction } from '../../utils/transaction.js';

const durationMs = (value) => {
  if (!value?.duration) return null;
  const multiplier = { MINUTES: 60_000, HOURS: 3_600_000, DAYS: 86_400_000 }[value.unit || 'HOURS'];
  return multiplier ? value.duration * multiplier : null;
};

const audit = async ({ organizationId, actorId, action, resourceId, changes, session }) => {
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

const currentRequestForStep = async (step, session) => {
  let requestQuery = Request.findOne({
    _id: step.requestId,
    organizationId: step.organizationId,
    status: 'PENDING_APPROVAL',
    currentSequence: step.sequence,
  }).lean();
  let latestQuery = ApprovalStep.findOne({
    organizationId: step.organizationId,
    requestId: step.requestId,
  }).sort({ attemptNumber: -1 }).select('attemptNumber').lean();
  if (session) {
    requestQuery = requestQuery.session(session);
    latestQuery = latestQuery.session(session);
  }
  const request = await requestQuery;
  if (!request) return null;
  const latest = await latestQuery;
  return latest?.attemptNumber === step.attemptNumber ? request : null;
};

const reminderRecipient = async ({ step, request, now }) => {
  if (step.claimedBy) {
    return User.findOne({
      _id: step.claimedBy,
      accountStatus: 'ACTIVE',
      organizationMemberships: { $elemMatch: { organizationId: step.organizationId, status: 'ACTIVE' } },
    }).select('name email').lean();
  }
  const delegator = await User.findOne({
    _id: step.approverId,
    accountStatus: 'ACTIVE',
    organizationMemberships: { $elemMatch: { organizationId: step.organizationId, status: 'ACTIVE' } },
  }).select('approvalDelegations').lean();
  const delegation = delegator?.approvalDelegations.find((item) =>
    String(item.organizationId) === String(step.organizationId) &&
    item.status === 'ACTIVE' &&
    item.startsAt <= now &&
    item.endsAt > now &&
    (item.scopeType === 'ORGANIZATION' || String(item.departmentId) === String(request.departmentId)) &&
    (!item.stageIds.length || item.stageIds.includes(step.stageId))
  );
  if (delegation) {
    const user = await User.findOne({
      _id: delegation.delegateId,
      accountStatus: 'ACTIVE',
      organizationMemberships: { $elemMatch: { organizationId: step.organizationId, status: 'ACTIVE' } },
    }).select('name email').lean();
    if (user) {
      const access = await resolveEffectivePermissions({ userId: user._id, organizationId: step.organizationId });
      if (hasEffectivePermission(access, 'requests.approve', request.departmentId)) return user;
    }
  }
  return User.findOne({
    _id: step.approverId,
    accountStatus: 'ACTIVE',
    organizationMemberships: { $elemMatch: { organizationId: step.organizationId, status: 'ACTIVE' } },
  }).select('name email').lean();
};

const resolveEscalationRecipient = async ({ step, request, policy }) => {
  if (policy.targetType === 'USER') {
    return User.findOne({
      _id: policy.targetId,
      accountStatus: 'ACTIVE',
      organizationMemberships: {
        $elemMatch: {
          organizationId: step.organizationId,
          status: 'ACTIVE',
          $or: [{ departmentId: null }, { departmentId: request.departmentId }],
        },
      },
    }).select('_id name email').lean();
  }
  if (policy.targetType !== 'ROLE') return null;
  const role = await Role.findOne({
    _id: policy.targetId,
    organizationId: step.organizationId,
    status: 'ACTIVE',
  }).select('_id').lean();
  if (!role) return null;
  const assignment = await UserRoleAssignment.findOne({
    organizationId: step.organizationId,
    roleId: role._id,
    status: 'ACTIVE',
    $or: [
      { scopeType: 'ORGANIZATION', departmentId: null },
      { scopeType: 'DEPARTMENT', departmentId: request.departmentId },
    ],
  }).select('userId').lean();
  if (!assignment) return null;
  return User.findOne({
    _id: assignment.userId,
    accountStatus: 'ACTIVE',
    organizationMemberships: { $elemMatch: { organizationId: step.organizationId, status: 'ACTIVE' } },
  }).select('_id name email').lean();
};

const safelyProcess = async (label, work) => {
  try {
    return await work();
  } catch (error) {
    console.error(`Approval ${label} processing failed:`, error.message);
    return null;
  }
};

export const processApprovalMaintenance = async ({ now = new Date(), send = sendApprovalNotification } = {}) => {
  const totals = { claimsReleased: 0, remindersSent: 0, escalationsSent: 0, overdueMarked: 0 };

  const expiredClaims = await safelyProcess('claim expiry query', () => ApprovalStep.find({
    status: 'CLAIMED',
    claimExpiresAt: { $ne: null, $lte: now },
  }).limit(200).lean()) || [];

  for (const candidate of expiredClaims) {
    if (!await safelyProcess('claim expiry eligibility', () => currentRequestForStep(candidate))) continue;
    const released = await safelyProcess('claim expiry', () => withTransaction(async (session) => {
      if (!await currentRequestForStep(candidate, session)) return null;
      const step = await ApprovalStep.findOneAndUpdate({
        _id: candidate._id,
        organizationId: candidate.organizationId,
        status: 'CLAIMED',
        claimedBy: candidate.claimedBy,
        claimExpiresAt: { $lte: now },
      }, {
        $set: { status: 'ACTIVE', claimedBy: null, claimedAt: null, claimExpiresAt: null, delegationId: null, actedOnBehalfOf: null },
      }, { new: true, session });
      if (!step) return null;
      await ApprovalStep.updateMany({
        organizationId: step.organizationId,
        requestId: step.requestId,
        attemptNumber: step.attemptNumber,
        sequence: step.sequence,
        _id: { $ne: step._id },
        status: 'CANCELLED',
        claimedBy: candidate.claimedBy,
        claimExpiresAt: { $lte: now },
      }, {
        $set: {
          status: 'ACTIVE',
          claimedBy: null,
          claimedAt: null,
          claimExpiresAt: null,
          delegationId: null,
          actedOnBehalfOf: null,
        },
      }, { session });
      await audit({
        organizationId: step.organizationId,
        actorId: step.approverId,
        action: 'APPROVAL_CLAIM_EXPIRED',
        resourceId: step._id,
        changes: { previousClaimedBy: String(candidate.claimedBy) },
        session,
      });
      return step.toObject();
    }));
    if (!released) continue;
    totals.claimsReleased += 1;
    const request = await safelyProcess('claim expiry request lookup', () => currentRequestForStep(released));
    if (request) {
      const priorClaimant = await User.findOne({
        _id: candidate.claimedBy,
        accountStatus: 'ACTIVE',
        organizationMemberships: { $elemMatch: { organizationId: released.organizationId, status: 'ACTIVE' } },
      }).select('_id name email').lean();
      if (priorClaimant) {
        await safelyProcess('claim expiry notification', () => send({
          recipient: priorClaimant,
          event: 'claim_expired',
          subject: `Approval claim expired: ${request.requestNumber}`,
          request,
          step: released,
        }));
      }
      const availableSteps = await safelyProcess('claim reassignment lookup', () => ApprovalStep.find({
        organizationId: released.organizationId,
        requestId: released.requestId,
        attemptNumber: released.attemptNumber,
        sequence: released.sequence,
        status: 'ACTIVE',
        claimedBy: null,
      }).lean()) || [];
      for (const availableStep of availableSteps) {
        const approver = await safelyProcess('claim reassignment recipient lookup', () => User.findOne({
          _id: availableStep.approverId,
          accountStatus: 'ACTIVE',
          organizationMemberships: { $elemMatch: { organizationId: released.organizationId, status: 'ACTIVE' } },
        }).select('_id name email').lean());
        if (approver) await safelyProcess('claim reassignment notification', () => send({
          recipient: approver,
          event: 'assigned',
          subject: `Approval available: ${request.requestNumber}`,
          request,
          step: availableStep,
        }));
      }
    }
  }

  const dueSteps = await safelyProcess('overdue query', () => ApprovalStep.find({
    status: { $in: ['ACTIVE', 'CLAIMED'] },
    isOverdue: false,
    slaDueAt: { $ne: null, $lte: now },
    $or: [{ status: 'CLAIMED' }, { status: 'ACTIVE', claimedBy: null }],
  }).limit(200).lean()) || [];

  for (const candidate of dueSteps) {
    const request = await safelyProcess('overdue request lookup', () => currentRequestForStep(candidate));
    if (!request) continue;
    const updated = await safelyProcess('overdue marking', () => ApprovalStep.findOneAndUpdate({
      _id: candidate._id,
      organizationId: candidate.organizationId,
      status: candidate.status,
      isOverdue: false,
      slaDueAt: { $lte: now },
      ...(candidate.status === 'CLAIMED' ? { claimedBy: candidate.claimedBy } : { claimedBy: null }),
    }, { $set: { isOverdue: true } }, { new: true }).lean());
    if (!updated) continue;
    totals.overdueMarked += 1;
    await safelyProcess('overdue audit', () => audit({
      organizationId: candidate.organizationId,
      actorId: updated.claimedBy || updated.approverId,
      action: 'APPROVAL_OVERDUE',
      resourceId: updated._id,
      changes: { slaDueAt: updated.slaDueAt },
    }));
    const recipient = updated.status === 'CLAIMED'
      ? await User.findOne({
        _id: updated.claimedBy,
        accountStatus: 'ACTIVE',
        organizationMemberships: { $elemMatch: { organizationId: updated.organizationId, status: 'ACTIVE' } },
      }).select('name email').lean()
      : await safelyProcess('overdue recipient lookup', () => reminderRecipient({ step: updated, request, now }));
    if (recipient) await safelyProcess('overdue notification', () => send({
      recipient,
      event: 'overdue',
      subject: `Approval overdue: ${request.requestNumber}`,
      request,
      step: updated,
    }));
  }

  const overdueSteps = await safelyProcess('escalation query', () => ApprovalStep.find({
    status: { $in: ['ACTIVE', 'CLAIMED'] },
    isOverdue: true,
    slaDueAt: { $ne: null },
    $or: [{ status: 'CLAIMED' }, { status: 'ACTIVE', claimedBy: null }],
  }).limit(200).lean()) || [];

  for (const candidate of overdueSteps) {
    const request = await safelyProcess('escalation request lookup', () => currentRequestForStep(candidate));
    if (!request) continue;
    const workflow = await safelyProcess('escalation workflow lookup', () => WorkflowDefinition.findOne({
      _id: candidate.workflowDefinitionId,
      organizationId: candidate.organizationId,
      version: candidate.workflowVersion,
    }).select('stages').lean());
    const config = workflow?.stages.find((stage) => stage.stageId === candidate.stageId)?.sla?.escalation;
    if (!config?.enabled) continue;
    const levels = config.levels?.length
      ? config.levels
      : (config.after && config.targetType && config.targetId ? [config] : []);
    const policy = levels[candidate.escalationLevel];
    if (!policy || now < new Date(candidate.slaDueAt.getTime() + durationMs({ duration: policy.after, unit: policy.unit }))) continue;
    const recipient = await safelyProcess('escalation recipient lookup', () =>
      resolveEscalationRecipient({ step: candidate, request, policy }));
    if (!recipient) continue;
    const marked = await safelyProcess('escalation reservation', () => ApprovalStep.findOneAndUpdate({
      _id: candidate._id,
      organizationId: candidate.organizationId,
      status: candidate.status,
      isOverdue: true,
      escalationLevel: candidate.escalationLevel,
      lastEscalatedAt: candidate.lastEscalatedAt,
      ...(candidate.status === 'CLAIMED' ? { claimedBy: candidate.claimedBy } : { claimedBy: null }),
    }, { $set: { lastEscalatedAt: now, escalationLevel: candidate.escalationLevel + 1 } }, { new: true }).lean());
    if (!marked) continue;
    let delivered = false;
    try {
      await send({
        recipient,
        event: 'escalated',
        subject: `Approval escalation: ${request.requestNumber}`,
        request,
        step: marked,
      });
      delivered = true;
    } catch (error) {
      await ApprovalStep.updateOne(
        { _id: candidate._id, lastEscalatedAt: now, escalationLevel: candidate.escalationLevel + 1 },
        { $set: { lastEscalatedAt: candidate.lastEscalatedAt, escalationLevel: candidate.escalationLevel } }
      );
      console.error('Approval escalation delivery failed:', error.message);
    }
    if (delivered) {
      await safelyProcess('escalation audit', () => audit({
        organizationId: candidate.organizationId,
        actorId: candidate.approverId,
        action: 'APPROVAL_ESCALATED',
        resourceId: candidate._id,
        changes: { recipientId: String(recipient._id), escalationLevel: 1 },
      }));
      totals.escalationsSent += 1;
    }
  }

  const dueReminders = await safelyProcess('reminder query', () => ApprovalStep.find({
    status: { $in: ['ACTIVE', 'CLAIMED'] },
    nextReminderAt: { $ne: null, $lte: now },
    $or: [{ status: 'CLAIMED' }, { status: 'ACTIVE', claimedBy: null }],
  }).limit(200).lean()) || [];

  for (const candidate of dueReminders) {
    const request = await safelyProcess('reminder request lookup', () => currentRequestForStep(candidate));
    if (!request) continue;
    const reserved = await safelyProcess('reminder reservation', () => ApprovalStep.findOneAndUpdate({
      _id: candidate._id,
      organizationId: candidate.organizationId,
      status: candidate.status,
      nextReminderAt: candidate.nextReminderAt,
      ...(candidate.status === 'CLAIMED' ? { claimedBy: candidate.claimedBy } : { claimedBy: null }),
    }, { $set: { nextReminderAt: null }, $inc: { reminderCount: 1 } }, { new: true }).lean());
    if (!reserved) continue;
    const [recipient, workflow] = await safelyProcess('reminder metadata lookup', () => Promise.all([
      reminderRecipient({ step: reserved, request, now }),
      WorkflowDefinition.findOne({
        _id: reserved.workflowDefinitionId,
        organizationId: reserved.organizationId,
        version: reserved.workflowVersion,
      }).select('stages').lean(),
    ])) || [];
    if (!workflow) {
      await ApprovalStep.updateOne({
        _id: reserved._id,
        status: candidate.status,
        reminderCount: reserved.reminderCount,
        nextReminderAt: null,
      }, {
        $set: { nextReminderAt: new Date(now.getTime() + 15 * 60 * 1000) },
        $inc: { reminderCount: -1 },
      });
      continue;
    }
    let delivered = false;
    try {
      if (!recipient?.email) throw new Error('No active reminder recipient is available.');
      await send({
        recipient,
        event: 'reminder',
        subject: `Approval reminder: ${request.requestNumber}`,
        request,
        step: reserved,
      });
      delivered = true;
    } catch (error) {
      await ApprovalStep.updateOne({
        _id: reserved._id,
        status: candidate.status,
        reminderCount: reserved.reminderCount,
        nextReminderAt: null,
      }, {
        $set: { nextReminderAt: new Date(now.getTime() + 15 * 60 * 1000) },
        $inc: { reminderCount: -1 },
      });
      console.error('Approval reminder delivery failed:', error.message);
    }
    if (!delivered) continue;

    await safelyProcess('reminder schedule update', async () => {
      const schedule = workflow?.stages.find((stage) => stage.stageId === reserved.stageId)?.sla?.reminders || [];
      const next = schedule[reserved.reminderCount];
      const nextReminderAt = next && reserved.slaStartedAt
        ? new Date(reserved.slaStartedAt.getTime() + durationMs({ duration: next.after, unit: next.unit }))
        : null;
      await ApprovalStep.updateOne({
        _id: reserved._id,
        status: candidate.status,
        reminderCount: reserved.reminderCount,
        nextReminderAt: null,
      }, { $set: { lastReminderAt: now, nextReminderAt } });
      await audit({
        organizationId: reserved.organizationId,
        actorId: reserved.claimedBy || recipient._id,
        action: 'APPROVAL_REMINDER_SENT',
        resourceId: reserved._id,
        changes: { reminderCount: reserved.reminderCount },
      });
      totals.remindersSent += 1;
    });
  }
  return totals;
};
