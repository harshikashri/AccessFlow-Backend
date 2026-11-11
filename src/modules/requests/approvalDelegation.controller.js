import * as service from './approvalDelegation.service.js';
import { validateDelegation, validateDelegationId } from './approvalDelegation.validation.js';
import { notifyDelegationChange, runApprovalNotificationSafely } from '../../services/email/approvalLifecycle.service.js';

export const createDelegation = async (req, res) => {
  const data = await service.createDelegation({
    organizationId: req.auth.organizationId,
    actorId: req.auth.userId,
    access: req.requestAccess,
    input: validateDelegation(req.body),
  });
  await runApprovalNotificationSafely(() => notifyDelegationChange({
    organizationId: req.auth.organizationId,
    delegation: data,
    event: 'delegation_created',
  }));
  return res.status(201).json({ success: true, message: 'Approval delegation created successfully.', data });
};

export const listDelegations = async (req, res) => res.status(200).json({
  success: true,
  message: 'Approval delegations retrieved successfully.',
  data: await service.listDelegations({ organizationId: req.auth.organizationId, actorId: req.auth.userId }),
});

export const getDelegation = async (req, res) => res.status(200).json({
  success: true,
  message: 'Approval delegation retrieved successfully.',
  data: await service.getDelegation({
    organizationId: req.auth.organizationId,
    actorId: req.auth.userId,
    delegationId: validateDelegationId(req.params.delegationId),
  }),
});

export const revokeDelegation = async (req, res) => {
  const data = await service.revokeDelegation({
    organizationId: req.auth.organizationId,
    actorId: req.auth.userId,
    delegationId: validateDelegationId(req.params.delegationId),
  });
  await runApprovalNotificationSafely(() => notifyDelegationChange({
    organizationId: req.auth.organizationId,
    delegation: data,
    event: 'delegation_revoked',
  }));
  return res.status(200).json({ success: true, message: 'Approval delegation revoked successfully.', data });
};

export const updateDelegation = async (req, res) => res.status(200).json({
  success: true,
  message: 'Approval delegation updated successfully.',
  data: await service.updateDelegation({
    organizationId: req.auth.organizationId,
    actorId: req.auth.userId,
    access: req.requestAccess,
    delegationId: validateDelegationId(req.params.delegationId),
    input: validateDelegation(req.body),
  }),
});
