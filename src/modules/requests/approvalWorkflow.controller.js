import * as workflowService from './approvalWorkflow.service.js';
import { validateApprovalWorkflow, validateWorkflowId } from './approvalWorkflow.validation.js';
import { AppError } from '../../utils/AppError.js';

export const createWorkflow = async (req, res) => {
  const data = await workflowService.createWorkflow({
    organizationId: req.auth.organizationId,
    actorId: req.auth.userId,
    input: validateApprovalWorkflow(req.body),
  });
  return res.status(201).json({ success: true, message: 'Approval workflow created successfully.', data });
};

export const listWorkflows = async (req, res) => {
  const page = Number(req.query.page || 1);
  const limit = Number(req.query.limit || 10);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new AppError('Invalid workflow pagination.', 400, 'VALIDATION_ERROR');
  }
  const data = await workflowService.listWorkflows({
    organizationId: req.auth.organizationId,
    page,
    limit,
    search: req.query.search?.trim(),
    isActive: req.query.isActive === undefined ? undefined : req.query.isActive === 'true',
    requestTypeId: req.query.requestTypeId,
  });
  return res.status(200).json({ success: true, message: 'Approval workflows retrieved successfully.', data });
};

export const getWorkflow = async (req, res) => {
  const data = await workflowService.getWorkflow({
    organizationId: req.auth.organizationId,
    workflowId: validateWorkflowId(req.params.workflowId),
  });
  return res.status(200).json({ success: true, message: 'Approval workflow retrieved successfully.', data });
};

export const updateWorkflow = async (req, res) => {
  const data = await workflowService.updateWorkflow({
    organizationId: req.auth.organizationId,
    actorId: req.auth.userId,
    workflowId: validateWorkflowId(req.params.workflowId),
    input: validateApprovalWorkflow(req.body),
  });
  return res.status(200).json({ success: true, message: 'Approval workflow updated successfully.', data });
};

export const setWorkflowStatus = (isActive) => async (req, res) => {
  const data = await workflowService.setWorkflowStatus({
    organizationId: req.auth.organizationId,
    actorId: req.auth.userId,
    workflowId: validateWorkflowId(req.params.workflowId),
    isActive,
  });
  return res.status(200).json({ success: true, message: `Approval workflow ${isActive ? 'activated' : 'deactivated'} successfully.`, data });
};

export const validateWorkflow = async (req, res) => {
  const data = await workflowService.validateWorkflow({
    organizationId: req.auth.organizationId,
    input: validateApprovalWorkflow(req.body),
  });
  return res.status(200).json({ success: true, message: 'Approval workflow is valid.', data });
};
