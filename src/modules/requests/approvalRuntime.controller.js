import { withTransaction } from '../../utils/transaction.js';
import * as approvalService from './approvalRuntime.service.js';
import { validateApprovalComment, validateApprovalStepId } from './approvalRuntime.validation.js';
import { validateApprovalInboxQuery, validateReturnReason } from './approvalRuntime.validation.js';
import { notifyApprovalAction, runApprovalNotificationSafely } from '../../services/email/approvalLifecycle.service.js';

export const listApprovalInbox = async (req, res) => {
  const data = await approvalService.listApprovalInbox({
    organizationId: req.auth.organizationId,
    actorId: req.auth.userId,
    access: req.requestAccess,
    query: validateApprovalInboxQuery(req.query),
  });
  return res.status(200).json({ success: true, message: 'Approval inbox retrieved successfully.', data });
};

export const getApprovalDetails = async (req, res) => {
  const data = await approvalService.getApprovalDetails({
    organizationId: req.auth.organizationId,
    actorId: req.auth.userId,
    access: req.requestAccess,
    approvalStepId: validateApprovalStepId(req.params.approvalStepId),
  });
  return res.status(200).json({ success: true, message: 'Approval details retrieved successfully.', data });
};

export const claimApproval = async (req, res) => {
  const data = await withTransaction((session) => approvalService.claimApproval({
    organizationId: req.auth.organizationId,
    approvalStepId: validateApprovalStepId(req.params.approvalStepId),
    actorId: req.auth.userId,
    access: req.requestAccess,
    session,
  }));
  await runApprovalNotificationSafely(() => notifyApprovalAction({
    organizationId: req.auth.organizationId,
    stepId: data._id,
    event: 'claimed',
  }));
  return res.status(200).json({ success: true, message: 'Approval claimed successfully.', data });
};

export const approveApproval = async (req, res) => {
  const data = await withTransaction((session) => approvalService.approveApproval({
    organizationId: req.auth.organizationId,
    approvalStepId: validateApprovalStepId(req.params.approvalStepId),
    actorId: req.auth.userId,
    access: req.requestAccess,
    comment: validateApprovalComment(req.body),
    session,
  }));
  await runApprovalNotificationSafely(() => notifyApprovalAction({
    organizationId: req.auth.organizationId,
    stepId: data._id,
    event: 'approved',
  }));
  return res.status(200).json({ success: true, message: 'Approval recorded successfully.', data });
};

export const rejectApproval = async (req, res) => {
  const data = await withTransaction((session) => approvalService.rejectApproval({
    organizationId: req.auth.organizationId,
    approvalStepId: validateApprovalStepId(req.params.approvalStepId),
    actorId: req.auth.userId,
    access: req.requestAccess,
    comment: validateApprovalComment(req.body),
    session,
  }));
  await runApprovalNotificationSafely(() => notifyApprovalAction({
    organizationId: req.auth.organizationId,
    stepId: data._id,
    event: 'rejected',
  }));
  return res.status(200).json({ success: true, message: 'Rejection recorded successfully.', data });
};

export const returnApproval = async (req, res) => {
  const data = await withTransaction((session) => approvalService.returnApproval({
    organizationId: req.auth.organizationId,
    approvalStepId: validateApprovalStepId(req.params.approvalStepId),
    actorId: req.auth.userId,
    access: req.requestAccess,
    reason: validateReturnReason(req.body),
    session,
  }));
  await runApprovalNotificationSafely(() => notifyApprovalAction({
    organizationId: req.auth.organizationId,
    stepId: data._id,
    event: 'returned',
  }));
  return res.status(200).json({ success: true, message: 'Request returned for revision.', data });
};
