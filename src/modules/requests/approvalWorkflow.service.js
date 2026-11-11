import mongoose from 'mongoose';
import WorkflowDefinition from '../../models/WorkflowDefinition.js';
import Role from '../../models/Role.js';
import User from '../../models/User.js';
import Organization from '../../models/Organization.js';
import AuditLog from '../../models/AuditLog.js';
import { AppError } from '../../utils/AppError.js';
import { withTransaction } from '../../utils/transaction.js';
import { WORKFLOW_ACTIONS } from './request.constants.js';
import { validateWorkflowCondition } from './approvalWorkflow.validation.js';

const FINANCE_APPROVER_ROLE_NAME = 'Finance Approver';

const publicWorkflow = (workflow) => ({
  id: String(workflow._id),
  organizationId: String(workflow.organizationId),
  definitionType: workflow.definitionType,
  name: workflow.name,
  description: workflow.description || '',
  requestTypeId: workflow.requestTypeId ? String(workflow.requestTypeId) : null,
  version: workflow.version,
  isDefault: workflow.isDefault === true,
  isActive: workflow.isActive,
  stages: workflow.stages || [],
  createdBy: workflow.createdBy ? String(workflow.createdBy) : null,
  updatedBy: workflow.updatedBy ? String(workflow.updatedBy) : null,
  createdAt: workflow.createdAt,
  updatedAt: workflow.updatedAt,
});

const writeAudit = async (session, { organizationId, actorId, action, resourceId, changes }) => {
  await AuditLog.create([{
    organizationId,
    actorId,
    action,
    resourceType: 'ApprovalWorkflow',
    resourceId,
    changes,
    timestamp: new Date(),
  }], { session });
};

const assertOrganization = async (organizationId, session) => {
  let query = Organization.findOne({ _id: organizationId, status: 'ACTIVE' }).select('_id');
  if (session) query = query.session(session);
  if (!await query) throw new AppError('Organization not found or inactive.', 404, 'ORGANIZATION_NOT_FOUND');
};

const findRequestType = async ({ organizationId, requestTypeId, session }) => {
  if (!requestTypeId) return null;
  let query = WorkflowDefinition.findOne({
    _id: requestTypeId,
    organizationId,
    definitionType: 'REQUEST_TYPE',
    isActive: true,
  });
  if (session) query = query.session(session);
  const type = await query;
  if (!type) throw new AppError('Request type not found in this organization.', 404, 'REQUEST_TYPE_NOT_FOUND');
  return type;
};

const validateReferences = async ({ organizationId, stages, requestType, session }) => {
  const fields = requestType?.fields || [{ key: 'amount', type: 'NUMBER', required: false }];
  for (const stage of stages) {
    validateWorkflowCondition(stage.condition, fields);
    if (stage.assignment.type === 'ROLE') {
      let query = Role.findOne({ _id: stage.assignment.roleId, organizationId, status: 'ACTIVE' });
      if (session) query = query.session(session);
      if (!await query) throw new AppError('Approval role not found or inactive in this organization.', 404, 'ROLE_NOT_FOUND');
    }
    if (stage.assignment.type === 'USER') {
      let query = User.findOne({
        _id: stage.assignment.userId,
        accountStatus: 'ACTIVE',
        organizationMemberships: { $elemMatch: { organizationId, status: 'ACTIVE' } },
      }).select('_id');
      if (session) query = query.session(session);
      if (!await query) throw new AppError('Approval user is not active in this organization.', 404, 'USER_NOT_FOUND');
    }
    if (stage.sla?.escalation?.enabled) {
      const policies = stage.sla.escalation.levels?.length
        ? stage.sla.escalation.levels
        : [stage.sla.escalation];
      for (const policy of policies) {
        if (policy.targetType === 'ROLE') {
          let query = Role.findOne({
            _id: policy.targetId,
            organizationId,
            status: 'ACTIVE',
          });
          if (session) query = query.session(session);
          if (!await query) throw new AppError('Escalation role not found or inactive in this organization.', 404, 'ROLE_NOT_FOUND');
        } else if (policy.targetType === 'USER') {
          let query = User.findOne({
            _id: policy.targetId,
            accountStatus: 'ACTIVE',
            organizationMemberships: { $elemMatch: { organizationId, status: 'ACTIVE' } },
          }).select('_id');
          if (session) query = query.session(session);
          if (!await query) throw new AppError('Escalation user is not active in this organization.', 404, 'USER_NOT_FOUND');
        }
      }
    }
  }
};

const latestVersion = async ({ organizationId, requestTypeId, isDefault, session }) => {
  const filter = { organizationId, definitionType: 'APPROVAL_WORKFLOW' };
  if (isDefault) filter.isDefault = true;
  else filter.requestTypeId = requestTypeId;
  let query = WorkflowDefinition.findOne(filter).sort({ version: -1 });
  if (session) query = query.session(session);
  return query;
};

export const initializeDefaultApprovalWorkflow = async ({ session, organizationId, actorId }) => {
  const existing = await latestVersion({ organizationId, isDefault: true, session });
  if (existing) return existing;

  const financeRoles = await Role.find({
    organizationId,
    $or: [
      { roleType: 'FINANCE_APPROVER' },
      { nameNormalized: FINANCE_APPROVER_ROLE_NAME.toLocaleLowerCase('en-US') },
      { name: FINANCE_APPROVER_ROLE_NAME },
    ],
  }).session(session);
  if (financeRoles.length > 1) {
    throw new AppError('Multiple Finance Approver roles exist in this organization.', 409, 'FINANCE_ROLE_AMBIGUOUS');
  }
  let role = financeRoles[0] || null;
  if (role && role.status !== 'ACTIVE') {
    throw new AppError('The Finance Approver role must be active before initializing the default workflow.', 409, 'FINANCE_ROLE_INACTIVE');
  }
  if (!role) {
    [role] = await Role.create([{
      organizationId,
      name: FINANCE_APPROVER_ROLE_NAME,
      description: 'Built-in role for finance approval stages.',
      roleType: 'FINANCE_APPROVER',
      permissions: ['requests.approve'],
      status: 'ACTIVE',
      createdBy: actorId,
    }], { session });
  }
  const workflow = new WorkflowDefinition({
    organizationId,
    definitionType: 'APPROVAL_WORKFLOW',
    name: 'Default Approval Workflow',
    description: 'Mandatory department manager approval with conditional finance approval.',
    requestTypeId: null,
    isDefault: true,
    isActive: true,
    version: 1,
    stages: [
      {
        stageId: 'department-manager-approval',
        sequence: 1,
        name: 'Department Manager Approval',
        approverType: 'DEPARTMENT_MANAGER',
        assignment: { type: 'DEPARTMENT_MANAGER', resolution: 'CLAIM_ONE' },
        approvalMode: 'ANY',
        isMandatory: true,
        isConfigurable: false,
        condition: null,
      },
      {
        stageId: 'finance-approval',
        sequence: 2,
        name: 'Finance Approval',
        approverType: 'ROLE',
        assignment: { type: 'ROLE', roleId: role._id, resolution: 'CLAIM_ONE' },
        roleId: role._id,
        approvalMode: 'ANY',
        isMandatory: false,
        isConfigurable: true,
        condition: { field: 'amount', operator: 'GREATER_THAN', value: 50000 },
      },
    ],
    createdBy: actorId,
    updatedBy: actorId,
  });
  await workflow.save({ session });
  await writeAudit(session, {
    organizationId,
    actorId,
    action: WORKFLOW_ACTIONS.DEFAULT_INITIALIZED,
    resourceId: workflow._id,
    changes: { version: 1, financeThreshold: 50000, financeRoleId: String(role._id) },
  });
  return workflow;
};

export const createWorkflow = async ({ organizationId, actorId, input }) => withTransaction(async (session) => {
  await assertOrganization(organizationId, session);
  if (!input.requestTypeId) {
    throw new AppError('Custom workflows must target a request type.', 400, 'REQUEST_TYPE_REQUIRED');
  }
  const requestType = await findRequestType({ organizationId, requestTypeId: input.requestTypeId, session });
  await validateReferences({ organizationId, stages: input.stages, requestType, session });
  const duplicate = await latestVersion({ organizationId, requestTypeId: input.requestTypeId, isDefault: false, session });
  if (duplicate?.isActive) throw new AppError('An active workflow already exists for this request type.', 409, 'WORKFLOW_EXISTS');
  const workflow = new WorkflowDefinition({
    ...input,
    organizationId,
    definitionType: 'APPROVAL_WORKFLOW',
    isDefault: false,
    isActive: true,
    version: duplicate ? duplicate.version + 1 : 1,
    createdBy: actorId,
    updatedBy: actorId,
  });
  await workflow.save({ session });
  await writeAudit(session, { organizationId, actorId, action: WORKFLOW_ACTIONS.CREATED, resourceId: workflow._id, changes: { version: workflow.version } });
  return publicWorkflow(workflow);
});

export const listWorkflows = async ({ organizationId, page = 1, limit = 10, search, isActive, requestTypeId }) => {
  await assertOrganization(organizationId);
  const filter = { organizationId, definitionType: 'APPROVAL_WORKFLOW' };
  if (search) filter.name = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  if (isActive !== undefined) filter.isActive = isActive;
  if (requestTypeId) filter.requestTypeId = requestTypeId;
  const [items, total] = await Promise.all([
    WorkflowDefinition.find(filter).sort({ isDefault: -1, updatedAt: -1 }).skip((page - 1) * limit).limit(limit),
    WorkflowDefinition.countDocuments(filter),
  ]);
  return { items: items.map(publicWorkflow), pagination: { page, limit, total, totalPages: total ? Math.ceil(total / limit) : 0 } };
};

export const getWorkflow = async ({ organizationId, workflowId }) => {
  await assertOrganization(organizationId);
  const workflow = await WorkflowDefinition.findOne({ _id: workflowId, organizationId, definitionType: 'APPROVAL_WORKFLOW' });
  if (!workflow) throw new AppError('Approval workflow not found.', 404, 'WORKFLOW_NOT_FOUND');
  return publicWorkflow(workflow);
};

export const updateWorkflow = async ({ organizationId, actorId, workflowId, input }) => withTransaction(async (session) => {
  await assertOrganization(organizationId, session);
  const current = await WorkflowDefinition.findOne({ _id: workflowId, organizationId, definitionType: 'APPROVAL_WORKFLOW', isActive: true }).session(session);
  if (!current) throw new AppError('Active approval workflow not found.', 404, 'WORKFLOW_NOT_FOUND');
  if (current.isDefault && input.requestTypeId) {
    throw new AppError('The default workflow cannot be assigned to a specific request type.', 409, 'DEFAULT_WORKFLOW_PROTECTED');
  }
  if (!current.isDefault && input.requestTypeId && String(input.requestTypeId) !== String(current.requestTypeId)) {
    const conflicting = await latestVersion({ organizationId, requestTypeId: input.requestTypeId, isDefault: false, session });
    if (conflicting?.isActive) throw new AppError('An active workflow already exists for this request type.', 409, 'WORKFLOW_EXISTS');
  }
  const requestType = await findRequestType({ organizationId, requestTypeId: input.requestTypeId ?? current.requestTypeId, session });
  await validateReferences({ organizationId, stages: input.stages, requestType, session });
  const next = new WorkflowDefinition({
    ...input,
    organizationId,
    definitionType: 'APPROVAL_WORKFLOW',
    requestTypeId: input.requestTypeId ?? current.requestTypeId,
    isDefault: current.isDefault,
    isActive: true,
    version: current.version + 1,
    createdBy: current.createdBy,
    updatedBy: actorId,
  });
  current.isActive = false;
  current.isDefault = false;
  await current.save({ session });
  await next.save({ session });
  await writeAudit(session, { organizationId, actorId, action: WORKFLOW_ACTIONS.UPDATED, resourceId: next._id, changes: { previousWorkflowId: String(current._id), version: next.version } });
  return publicWorkflow(next);
});

export const setWorkflowStatus = async ({ organizationId, actorId, workflowId, isActive }) => withTransaction(async (session) => {
  await assertOrganization(organizationId, session);
  const workflow = await WorkflowDefinition.findOne({ _id: workflowId, organizationId, definitionType: 'APPROVAL_WORKFLOW' }).session(session);
  if (!workflow) throw new AppError('Approval workflow not found.', 404, 'WORKFLOW_NOT_FOUND');
  if (!isActive && workflow.isDefault) throw new AppError('The default workflow cannot be deactivated.', 409, 'DEFAULT_WORKFLOW_PROTECTED');
  workflow.isActive = isActive;
  workflow.updatedBy = actorId;
  await workflow.save({ session });
  await writeAudit(session, { organizationId, actorId, action: isActive ? WORKFLOW_ACTIONS.ACTIVATED : WORKFLOW_ACTIONS.DEACTIVATED, resourceId: workflow._id, changes: { isActive } });
  return publicWorkflow(workflow);
});

export const validateWorkflow = async ({ organizationId, input }) => {
  await assertOrganization(organizationId);
  const requestType = await findRequestType({ organizationId, requestTypeId: input.requestTypeId });
  await validateReferences({ organizationId, stages: input.stages, requestType });
  return { valid: true };
};
