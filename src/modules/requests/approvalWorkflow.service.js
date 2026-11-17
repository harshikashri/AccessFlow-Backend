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
import { getSupportedRoleScopes } from '../roles/role.scope.js';

const FINANCE_APPROVER_ROLE_NAME = 'Finance Approver';
const DEFAULT_FINANCE_CONDITION = { field: 'amount', operator: 'GREATER_THAN', value: 50000 };

const publicWorkflow = (workflow) => ({
  id: String(workflow._id),
  organizationId: String(workflow.organizationId),
  definitionType: workflow.definitionType,
  name: workflow.name,
  description: workflow.description || '',
  requestTypeId: workflow.requestTypeId ? String(workflow.requestTypeId) : null,
  workflowScope: workflow.workflowScope || 'DEPARTMENT',
  selectionCondition: workflow.selectionCondition || null,
  priority: workflow.priority ?? 0,
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

const validateReferences = async ({
  organizationId,
  stages,
  requestType,
  selectionCondition = null,
  session,
}) => {
  const fields = requestType?.fields || [{ key: 'amount', type: 'NUMBER', required: false }];
  validateWorkflowCondition(selectionCondition, fields);
  for (const stage of stages) {
    validateWorkflowCondition(stage.condition, fields);
    if (stage.assignment.type === 'ROLE') {
      let query = Role.findOne({ _id: stage.assignment.roleId, organizationId, status: 'ACTIVE' });
      if (session) query = query.session(session);
      const role = await query;
      if (!role) throw new AppError('Approval role not found or inactive in this organization.', 404, 'ROLE_NOT_FOUND');
      if (!role.permissions?.includes('requests.approve')) {
        throw new AppError('Approval roles must include the requests.approve permission.', 400, 'APPROVAL_PERMISSION_REQUIRED');
      }
      const supportedScopes = getSupportedRoleScopes(role);
      if (!supportedScopes.length) {
        throw new AppError(
          `Role "${role.name}" has no configured assignment scope. Configure its supported scopes before using it in a workflow.`,
          409,
          'ROLE_ASSIGNMENT_SCOPE_UNCONFIGURED',
          { roleId: String(role._id) }
        );
      }
      if (!supportedScopes.includes(stage.assignment.scopeType)) {
        throw new AppError(
          `Role "${role.name}" does not support the ${stage.assignment.scopeType} scope selected for this workflow stage.`,
          400,
          'ROLE_APPROVAL_SCOPE_UNSUPPORTED',
          { roleId: String(role._id), supportedScopes, requestedScope: stage.assignment.scopeType }
        );
      }
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

const assertPriorityAvailable = async ({
  organizationId,
  requestTypeId,
  workflowScope = 'DEPARTMENT',
  priority,
  exceptWorkflowId = null,
  session,
}) => {
  const priorityFilter = priority === 0
    ? { $or: [{ priority: 0 }, { priority: { $exists: false } }] }
    : { priority };
  const scopeFilter = workflowScope === 'DEPARTMENT'
    ? { $or: [{ workflowScope: 'DEPARTMENT' }, { workflowScope: { $exists: false } }] }
    : { workflowScope };
  const query = WorkflowDefinition.findOne({
    organizationId,
    definitionType: 'APPROVAL_WORKFLOW',
    requestTypeId,
    isDefault: false,
    isActive: true,
    ...(exceptWorkflowId ? { _id: { $ne: exceptWorkflowId } } : {}),
    $and: [scopeFilter, priorityFilter],
  }).select('_id');
  if (session) query.session(session);
  if (await query) {
    throw new AppError(
      'An active workflow already uses this priority for the selected request type.',
      409,
      'WORKFLOW_PRIORITY_CONFLICT',
    );
  }
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
    workflowScope: 'DEPARTMENT',
    isDefault: true,
    isActive: true,
    selectionCondition: null,
    priority: 0,
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
        assignment: {
          type: 'ROLE',
          roleId: role._id,
          resolution: 'CLAIM_ONE',
          scopeType: 'DEPARTMENT',
        },
        roleId: role._id,
        approvalMode: 'ANY',
        isMandatory: true,
        isConfigurable: true,
        condition: { ...DEFAULT_FINANCE_CONDITION },
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
    changes: {
      version: 1,
      financeRoleId: String(role._id),
    },
  });
  return workflow;
};

export const createWorkflow = async ({ organizationId, actorId, input }) => withTransaction(async (session) => {
  await assertOrganization(organizationId, session);
  const isDefault = input.isDefault === true;
  const workflowScope = input.workflowScope || 'DEPARTMENT';
  const requestTypeId = isDefault ? null : input.requestTypeId;
  if (!isDefault && !requestTypeId) {
    throw new AppError('Custom workflows must target a request type.', 400, 'REQUEST_TYPE_REQUIRED');
  }
  if (isDefault) {
    if (workflowScope !== 'DEPARTMENT') {
      throw new AppError('The organization default workflow must be department-scoped.', 400, 'DEFAULT_WORKFLOW_SCOPE_INVALID');
    }
    const activeDefault = await WorkflowDefinition.exists({
      organizationId,
      definitionType: 'APPROVAL_WORKFLOW',
      isDefault: true,
      isActive: true,
    }).session(session);
    if (activeDefault) throw new AppError('An active organization default workflow already exists.', 409, 'DEFAULT_WORKFLOW_EXISTS');
  }
  const requestType = await findRequestType({ organizationId, requestTypeId, session });
  const selectionCondition = input.selectionCondition ?? null;
  const priority = input.priority ?? 0;
  await validateReferences({
    organizationId,
    stages: input.stages,
    requestType,
    selectionCondition,
    session,
  });
  if (!isDefault) {
    await assertPriorityAvailable({
      organizationId,
      requestTypeId,
      workflowScope,
      priority,
      session,
    });
  } else if (selectionCondition) {
    throw new AppError('The organization default workflow cannot have a selection condition.', 400, 'DEFAULT_WORKFLOW_CONDITION_INVALID');
  }
  const workflow = new WorkflowDefinition({
    ...input,
    organizationId,
    definitionType: 'APPROVAL_WORKFLOW',
    requestTypeId,
    workflowScope,
    isDefault,
    selectionCondition,
    priority,
    isActive: true,
    version: 1,
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
  if (input.isDefault !== undefined && input.isDefault !== current.isDefault) {
    throw new AppError('A workflow cannot be converted between default and request-type scope while editing.', 409, 'WORKFLOW_SCOPE_IMMUTABLE');
  }
  const stages = input.stages;
  const workflowScope = input.workflowScope ?? current.workflowScope ?? 'DEPARTMENT';
  const requestTypeId = current.isDefault ? null : (input.requestTypeId ?? current.requestTypeId);
  const requestType = await findRequestType({ organizationId, requestTypeId, session });
  const selectionCondition = input.selectionCondition === undefined
    ? current.selectionCondition || null
    : input.selectionCondition;
  const priority = input.priority ?? current.priority ?? 0;
  await validateReferences({
    organizationId,
    stages,
    requestType,
    selectionCondition,
    session,
  });
  if (!current.isDefault) {
    await assertPriorityAvailable({
      organizationId,
      requestTypeId,
      workflowScope,
      priority,
      exceptWorkflowId: current._id,
      session,
    });
  } else if (selectionCondition) {
    throw new AppError('The organization default workflow cannot have a selection condition.', 400, 'DEFAULT_WORKFLOW_CONDITION_INVALID');
  }
  const next = new WorkflowDefinition({
    ...input,
    organizationId,
    definitionType: 'APPROVAL_WORKFLOW',
    requestTypeId,
    workflowScope,
    selectionCondition,
    priority,
    isDefault: current.isDefault,
    isActive: true,
    version: current.version + 1,
    stages,
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
  if (isActive) {
    const requestType = await findRequestType({
      organizationId,
      requestTypeId: workflow.isDefault ? null : workflow.requestTypeId,
      session,
    });
    await validateReferences({
      organizationId,
      stages: workflow.stages,
      requestType,
      selectionCondition: workflow.selectionCondition || null,
      session,
    });
    if (workflow.isDefault) {
      const activeDefault = await WorkflowDefinition.exists({
        organizationId,
        definitionType: 'APPROVAL_WORKFLOW',
        isDefault: true,
        isActive: true,
        _id: { $ne: workflow._id },
      }).session(session);
      if (activeDefault) throw new AppError('An active organization default workflow already exists.', 409, 'DEFAULT_WORKFLOW_EXISTS');
    } else {
      await assertPriorityAvailable({
        organizationId,
        requestTypeId: workflow.requestTypeId,
        workflowScope: workflow.workflowScope || 'DEPARTMENT',
        priority: workflow.priority ?? 0,
        exceptWorkflowId: workflow._id,
        session,
      });
    }
  }
  workflow.isActive = isActive;
  workflow.updatedBy = actorId;
  await workflow.save({ session });
  await writeAudit(session, { organizationId, actorId, action: isActive ? WORKFLOW_ACTIONS.ACTIVATED : WORKFLOW_ACTIONS.DEACTIVATED, resourceId: workflow._id, changes: { isActive } });
  return publicWorkflow(workflow);
});

export const validateWorkflow = async ({ organizationId, input }) => {
  await assertOrganization(organizationId);
  const requestType = await findRequestType({ organizationId, requestTypeId: input.requestTypeId });
  await validateReferences({
    organizationId,
    stages: input.stages,
    requestType,
    selectionCondition: input.selectionCondition || null,
  });
  if (!input.isDefault) {
    await assertPriorityAvailable({
      organizationId,
      requestTypeId: input.requestTypeId,
      workflowScope: input.workflowScope || 'DEPARTMENT',
      priority: input.priority ?? 0,
    });
  }
  return { valid: true };
};
