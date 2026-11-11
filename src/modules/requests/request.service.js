import crypto from 'node:crypto';
import mongoose from 'mongoose';
import Request from '../../models/Request.js';
import WorkflowDefinition from '../../models/WorkflowDefinition.js';
import Organization from '../../models/Organization.js';
import Department from '../../models/Department.js';
import User from '../../models/User.js';
import AuditLog from '../../models/AuditLog.js';
import ApprovalStep from '../../models/ApprovalStep.js';
import { hasEffectivePermission } from '../../services/authorization/permission.service.js';
import { AppError } from '../../utils/AppError.js';
import { withTransaction } from '../../utils/transaction.js';
import { REQUEST_ACTIONS, REQUEST_TYPE_ACTIONS } from './request.constants.js';
import { escapeRegex, normalizeCode, toPublicRequest, toPublicRequestType } from './request.utils.js';
import { evaluateFields } from './request.conditions.js';
import { cancelPendingApprovals, createRuntimeApprovals } from './approvalRuntime.service.js';

const writeAuditLog = async (session, { organizationId, actorId, action, resourceType, resourceId, changes = {} }) => {
  await AuditLog.create([{
    organizationId,
    actorId,
    action,
    resourceType,
    resourceId,
    changes,
    timestamp: new Date(),
  }], { session });
};

const assertActiveOrganization = async (organizationId, session) => {
  let query = Organization.findById(organizationId).select('status');
  if (session) query = query.session(session);
  const organization = await query;
  if (!organization) throw new AppError('Organization not found.', 404, 'ORGANIZATION_NOT_FOUND');
  if (organization.status !== 'ACTIVE') throw new AppError('This organization is inactive.', 403, 'ORGANIZATION_INACTIVE');
  return organization;
};

const getActiveRequester = async ({ userId, organizationId, session }) => {
  let query = User.findOne({
    _id: userId,
    accountStatus: 'ACTIVE',
    organizationMemberships: { $elemMatch: { organizationId, status: 'ACTIVE' } },
  }).select('organizationMemberships');
  if (session) query = query.session(session);
  const user = await query;
  if (!user) throw new AppError('An active organization membership is required.', 403, 'NO_ORGANIZATION_MEMBERSHIP');
  return user;
};

const getDepartmentForRequester = async ({ departmentId, organizationId, userId, session }) => {
  let query = Department.findOne({ _id: departmentId, organizationId, status: 'ACTIVE' });
  if (session) query = query.session(session);
  const department = await query;
  if (!department) throw new AppError('Department not found or inactive.', 404, 'DEPARTMENT_NOT_FOUND');
  let userQuery = User.findOne({
    _id: userId,
    organizationMemberships: { $elemMatch: { organizationId, departmentId, status: 'ACTIVE' } },
  }).select('_id');
  if (session) userQuery = userQuery.session(session);
  if (!(await userQuery)) throw new AppError('The requester must be an active member of the selected department.', 403, 'DEPARTMENT_MEMBERSHIP_REQUIRED');
  return department;
};

const getRequestType = async ({ requestTypeId, organizationId, session, activeOnly = false }) => {
  const filter = { _id: requestTypeId, organizationId, definitionType: 'REQUEST_TYPE' };
  if (activeOnly) filter.isActive = true;
  let query = WorkflowDefinition.findOne(filter);
  if (session) query = query.session(session);
  const definition = await query;
  if (!definition) throw new AppError('Request type not found.', 404, 'REQUEST_TYPE_NOT_FOUND');
  return definition;
};

const getAmountField = (definition) => {
  const fields = definition.fields || [];
  const semanticField = fields.find((field) => field.semantic === 'AMOUNT');
  if (semanticField) return semanticField;
  if (normalizeCode(definition.code || '') !== 'purchase') return null;

  const candidates = fields.filter(
    (field) => field.key === 'estimatedCost' && field.type === 'NUMBER' && field.required === true
  );
  return candidates.length === 1 ? candidates[0] : null;
};

const dateOnly = (value) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
};

const validateDetails = (details, definition) => {
  const fields = definition.fields || [];
  const evaluatedFields = evaluateFields(fields, details);
  const fieldMap = new Map(fields.map((field) => [field.key, field]));
  const unknown = Object.keys(details || {}).filter((key) => !fieldMap.has(key));
  if (unknown.length) throw new AppError('Request contains unknown dynamic fields.', 400, 'INVALID_REQUEST_DETAILS', { fields: unknown });
  for (const field of evaluatedFields) {
    const value = details?.[field.key];
    const empty = value === undefined || value === null || value === '' ||
      (Array.isArray(value) && value.length === 0);
    if (field.effectiveRequired && field.visible && empty) {
      throw new AppError(`Request field ${field.key} is required.`, 400, 'INVALID_REQUEST_DETAILS');
    }
    if (empty && !(field.type === 'MULTI_SELECT' && Array.isArray(value) && field.validation?.minSelections > 0)) continue;
    if (field.type === 'TEXT' || field.type === 'TEXTAREA') {
      if (typeof value !== 'string') throw new AppError(`Request field ${field.key} must be text.`, 400, 'INVALID_REQUEST_DETAILS');
      if (field.validation?.minLength !== undefined && value.length < field.validation.minLength) {
        throw new AppError(`Request field ${field.key} is shorter than its minimum length.`, 400, 'INVALID_REQUEST_DETAILS');
      }
      if (field.validation?.maxLength !== undefined && value.length > field.validation.maxLength) {
        throw new AppError(`Request field ${field.key} exceeds its maximum length.`, 400, 'INVALID_REQUEST_DETAILS');
      }
      if (field.validation?.pattern && !(new RegExp(field.validation.pattern)).test(value)) {
        throw new AppError(`Request field ${field.key} has an invalid format.`, 400, 'INVALID_REQUEST_DETAILS');
      }
    } else if (field.type === 'NUMBER') {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new AppError(`Request field ${field.key} must be a number.`, 400, 'INVALID_REQUEST_DETAILS');
      if ((field.validation?.integer || field.validation?.integerOnly) && !Number.isInteger(value)) {
        throw new AppError(`Request field ${field.key} must be an integer.`, 400, 'INVALID_REQUEST_DETAILS');
      }
      if ((field.validation?.positiveOnly || field.semantic === 'AMOUNT') && value <= 0) {
        throw new AppError(`Request field ${field.key} must be positive.`, 400, 'INVALID_REQUEST_DETAILS');
      }
      if (field.validation?.min !== undefined && value < field.validation.min) throw new AppError(`Request field ${field.key} is below its minimum.`, 400, 'INVALID_REQUEST_DETAILS');
      if (field.validation?.max !== undefined && value > field.validation.max) throw new AppError(`Request field ${field.key} exceeds its maximum.`, 400, 'INVALID_REQUEST_DETAILS');
    } else if (field.type === 'DATE') {
      if (typeof value !== 'string') throw new AppError(`Request field ${field.key} must be a valid date.`, 400, 'INVALID_REQUEST_DETAILS');
      const timestamp = Date.parse(value);
      if (Number.isNaN(timestamp)) throw new AppError(`Request field ${field.key} must be a valid date.`, 400, 'INVALID_REQUEST_DETAILS');
      const today = dateOnly(new Date());
      const valueDate = dateOnly(value);
      if ((field.validation?.notPast || field.validation?.notInPast) && valueDate < today) {
        throw new AppError(`Request field ${field.key} must not be in the past.`, 400, 'INVALID_REQUEST_DETAILS');
      }
      if (field.validation?.notInFuture && valueDate > today) {
        throw new AppError(`Request field ${field.key} must not be in the future.`, 400, 'INVALID_REQUEST_DETAILS');
      }
      if (field.validation?.minDate && valueDate < dateOnly(field.validation.minDate)) {
        throw new AppError(`Request field ${field.key} is before its minimum date.`, 400, 'INVALID_REQUEST_DETAILS');
      }
      if (field.validation?.maxDate && valueDate > dateOnly(field.validation.maxDate)) {
        throw new AppError(`Request field ${field.key} is after its maximum date.`, 400, 'INVALID_REQUEST_DETAILS');
      }
      if (field.validation?.gteField) {
        const otherTimestamp = Date.parse(details?.[field.validation.gteField]);
        if (Number.isNaN(otherTimestamp) || timestamp < otherTimestamp) {
          throw new AppError(`Request field ${field.key} must be on or after ${field.validation.gteField}.`, 400, 'INVALID_REQUEST_DETAILS');
        }
      }
    } else if (field.type === 'SELECT') {
      if (typeof value !== 'string' || !field.options?.includes(value)) throw new AppError(`Request field ${field.key} has an invalid option.`, 400, 'INVALID_REQUEST_DETAILS');
    } else if (field.type === 'MULTI_SELECT') {
      const selections = Array.isArray(value) ? value : [];
      if (!Array.isArray(value) || new Set(selections).size !== selections.length ||
          selections.some((item) => typeof item !== 'string' || !field.options?.includes(item)) ||
          (field.validation?.minSelections !== undefined && selections.length < field.validation.minSelections) ||
          (field.validation?.maxSelections !== undefined && selections.length > field.validation.maxSelections)) {
        throw new AppError(`Request field ${field.key} has invalid options.`, 400, 'INVALID_REQUEST_DETAILS');
      }
    } else if (field.type === 'CHECKBOX' && typeof value !== 'boolean') {
      throw new AppError(`Request field ${field.key} must be boolean.`, 400, 'INVALID_REQUEST_DETAILS');
    }
  }
};

const generateRequestNumber = () => {
  const year = String(new Date().getFullYear()).slice(-2);
  return `REQ-${year}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
};

const mapDuplicateError = (error) => {
  if (error?.code === 11000) {
    const key = Object.keys(error.keyPattern || error.keyValue || {});
    if (key.includes('requestNumber')) return new AppError('A request number collision occurred. Please retry.', 409, 'REQUEST_NUMBER_COLLISION');
    if (key.includes('codeNormalized')) return new AppError('A request type with this code already exists.', 409, 'REQUEST_TYPE_CODE_EXISTS');
  }
  return error;
};

const resolveRequestVisibility = async ({ organizationId, actorId, access }) => {
  const isOrganizationAdmin = access.assignments.some(
    (assignment) => assignment.roleId?.roleType === 'ORGANIZATION_ADMIN'
  );
  const isDepartmentManager = access.assignments.some(
    (assignment) => assignment.roleId?.roleType === 'DEPARTMENT_MANAGER'
  );
  const canViewOrganization = isOrganizationAdmin &&
    access.organizationPermissions.has('requests.view');
  const delegatedUsers = await User.find({
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
  }).select('_id approvalDelegations').lean();
  const delegatedUsersById = new Map(delegatedUsers.map((user) => [String(user._id), user]));
  const delegatorIds = delegatedUsers.flatMap((user) =>
    user.approvalDelegations
      .filter((delegation) =>
        String(delegation.organizationId) === String(organizationId) &&
        String(delegation.delegateId) === String(actorId) &&
        delegation.status === 'ACTIVE' &&
        delegation.startsAt <= new Date() &&
        delegation.endsAt > new Date()
      )
      .map(() => String(user._id))
  );
  const relevantSteps = await ApprovalStep.find({
    organizationId,
    $or: [
      { approverId: actorId },
      { decidedBy: actorId },
      { returnedBy: actorId },
      { claimedBy: actorId },
      ...(delegatorIds.length ? [{ approverId: { $in: delegatorIds } }] : []),
    ],
  }).select('requestId attemptNumber approverId stageId sequence status decidedBy returnedBy claimedBy actedOnBehalfOf').lean();
  const candidateRequestIds = [...new Set(relevantSteps.map((step) => String(step.requestId)))];
  const relevantRequests = candidateRequestIds.length
    ? await Request.find({ organizationId, _id: { $in: candidateRequestIds } })
      .select('_id departmentId')
      .lean()
    : [];
  const relevantDepartmentByRequest = new Map(relevantRequests.map((item) => [String(item._id), item.departmentId]));
  const requestVisibility = {
    actorId,
    organizationId,
    delegatedUsersById,
  };
  const relevantApprovalRequestIds = new Set(
    relevantSteps
      .filter((step) => {
        const departmentId = relevantDepartmentByRequest.get(String(step.requestId));
        if (!departmentId || isDepartmentManager ||
            !hasEffectivePermission(access, 'requests.approve', departmentId)) return false;
        const delegatedAssignment = isDelegatedForStep(requestVisibility, step, departmentId);
        const delegatedAction = step.actedOnBehalfOf &&
          String(step.actedOnBehalfOf) !== String(actorId);
        if (delegatedAction) return delegatedAssignment;
        return String(step.approverId) === String(actorId) ||
          String(step.decidedBy) === String(actorId) ||
          String(step.returnedBy) === String(actorId) ||
          String(step.claimedBy) === String(actorId) ||
          delegatedAssignment;
      })
      .map((step) => String(step.requestId))
  );
  return {
    actorId,
    organizationId,
    access,
    isDepartmentManager,
    canViewOrganization,
    relevantApprovalRequestIds,
    relevantSteps,
    delegatorIds: [...new Set(delegatorIds)],
    delegatedUsersById,
  };
};

const getRequestVisibilityFilter = ({ actorId, requestVisibility }) => {
  const scopes = [{ requesterId: actorId }];
  if (requestVisibility.canViewOrganization) scopes.push({});
  if (requestVisibility.relevantApprovalRequestIds.size) {
    scopes.push({ _id: { $in: [...requestVisibility.relevantApprovalRequestIds] } });
  }
  return { $or: scopes };
};

const isDelegatedForStep = (requestVisibility, step, departmentId) => {
  const delegatorId = String(step.approverId);
  const user = requestVisibility.delegatedUsersById.get(delegatorId);
  if (!user) return false;
  const now = new Date();
  return user.approvalDelegations.some((delegation) =>
    String(delegation.organizationId) === String(requestVisibility.organizationId) &&
    String(delegation.delegateId) === String(requestVisibility.actorId) &&
    delegation.status === 'ACTIVE' &&
    delegation.startsAt <= now &&
    delegation.endsAt > now &&
    (delegation.scopeType === 'ORGANIZATION' || String(delegation.departmentId) === String(departmentId)) &&
    (!delegation.stageIds.length || delegation.stageIds.includes(step.stageId))
  );
};

const getDerivedRequestIds = async ({ organizationId, actorId, requestVisibility, derivedFilter }) => {
  if (!derivedFilter) return null;
  const steps = requestVisibility.relevantSteps;
  if (derivedFilter === 'MY_APPROVED') {
    return [...new Set(steps.filter((step) => step.status === 'APPROVED' &&
      String(step.decidedBy) === String(actorId)).map((step) => String(step.requestId)))];
  }
  if (derivedFilter === 'MY_REJECTED') {
    return [...new Set(steps.filter((step) => step.status === 'REJECTED' &&
      String(step.decidedBy) === String(actorId)).map((step) => String(step.requestId)))];
  }
  if (derivedFilter === 'MY_RETURNED') {
    return [...new Set(steps.filter((step) => step.status === 'RETURNED' &&
      (String(step.returnedBy) === String(actorId) || String(step.decidedBy) === String(actorId)))
      .map((step) => String(step.requestId)))];
  }
  if (derivedFilter === 'MY_ACTIONS') {
    return [...new Set(steps.filter((step) =>
      [step.decidedBy, step.returnedBy, step.claimedBy].some((id) => String(id) === String(actorId))
    ).map((step) => String(step.requestId)))];
  }

  const requestIds = [...new Set(steps
    .filter((step) => ['ACTIVE', 'CLAIMED'].includes(step.status))
    .map((step) => String(step.requestId)))];
  if (derivedFilter === 'WAITING_FOR_OTHERS') {
    const activeSteps = await ApprovalStep.find({
      organizationId,
      status: { $in: ['ACTIVE', 'CLAIMED'] },
    }).select('requestId attemptNumber sequence status approverId claimedBy').lean();
    const activeRequestIds = [...new Set(activeSteps.map((step) => String(step.requestId)))];
    if (!activeRequestIds.length) return [];
    const visibleRequests = await Request.find({
      organizationId,
      _id: { $in: activeRequestIds },
      status: 'PENDING_APPROVAL',
      ...getRequestVisibilityFilter({ actorId, requestVisibility }),
    }).select('_id departmentId currentSequence').lean();
    const visibleRequestById = new Map(visibleRequests.map((item) => [String(item._id), item]));
    const latestAttempts = await ApprovalStep.aggregate([
      { $match: { organizationId: new mongoose.Types.ObjectId(organizationId), requestId: { $in: visibleRequests.map((item) => item._id) } } },
      { $group: { _id: '$requestId', attemptNumber: { $max: '$attemptNumber' } } },
    ]);
    const latestAttemptByRequest = new Map(latestAttempts.map((item) => [String(item._id), item.attemptNumber]));
    const waitingForMe = new Set();
    const waitingForOthers = new Set();
    for (const step of activeSteps) {
      const request = visibleRequestById.get(String(step.requestId));
      if (!request ||
          Number(step.attemptNumber) !== Number(latestAttemptByRequest.get(String(step.requestId))) ||
          Number(step.sequence) !== Number(request.currentSequence)) continue;
      const assignedToActor = step.status === 'CLAIMED'
        ? String(step.claimedBy) === String(actorId)
        : String(step.approverId) === String(actorId) ||
          isDelegatedForStep(requestVisibility, step, request.departmentId);
      if (assignedToActor && hasEffectivePermission(access, 'requests.approve', request.departmentId)) {
        waitingForMe.add(String(step.requestId));
      } else {
        waitingForOthers.add(String(step.requestId));
      }
    }
    return [...waitingForOthers].filter((id) => !waitingForMe.has(id));
  }
  if (!requestIds.length) return [];
  const requests = await Request.find({
    organizationId,
    _id: { $in: requestIds },
    status: 'PENDING_APPROVAL',
  }).select('_id departmentId currentSequence').lean();
  const latestAttempts = await ApprovalStep.aggregate([
    { $match: { organizationId: new mongoose.Types.ObjectId(organizationId), requestId: { $in: requests.map((item) => item._id) } } },
    { $group: { _id: '$requestId', attemptNumber: { $max: '$attemptNumber' } } },
  ]);
  const latestAttemptByRequest = new Map(latestAttempts.map((item) => [String(item._id), item.attemptNumber]));
  const requestById = new Map(requests.map((request) => [String(request._id), request]));
  const waitingForMe = new Set();
  const waitingForOthers = new Set();
  for (const step of steps) {
    if (!['ACTIVE', 'CLAIMED'].includes(step.status)) continue;
    const request = requestById.get(String(step.requestId));
    if (!request ||
        Number(step.attemptNumber) !== Number(latestAttemptByRequest.get(String(step.requestId))) ||
        Number(step.sequence) !== Number(request.currentSequence)) continue;
    const assignedToActor = step.status === 'CLAIMED'
      ? String(step.claimedBy) === String(actorId)
      : String(step.approverId) === String(actorId) ||
        isDelegatedForStep(requestVisibility, step, request.departmentId);
    if (assignedToActor && hasEffectivePermission(requestVisibility.access, 'requests.approve', request.departmentId)) {
      waitingForMe.add(String(step.requestId));
    } else {
      waitingForOthers.add(String(step.requestId));
    }
  }
  return derivedFilter === 'WAITING_FOR_ME' ? [...waitingForMe] : [...waitingForOthers];
};

const enrichRequestSummaries = async ({ items, organizationId, actorId, requestVisibility }) => {
  if (!items.length) return [];
  const requestIds = items.map((item) => item._id);
  const userIds = [...new Set(items.map((item) => String(item.requesterId)))];
  const departmentIds = [...new Set(items.map((item) => String(item.departmentId)))];
  const [users, departments, steps] = await Promise.all([
    User.find({ _id: { $in: userIds }, organizationMemberships: { $elemMatch: { organizationId } } })
      .select('name email').lean(),
    Department.find({ _id: { $in: departmentIds }, organizationId }).select('name').lean(),
    ApprovalStep.find({
      organizationId,
      requestId: { $in: requestIds },
      $or: [{ status: { $in: ['ACTIVE', 'CLAIMED'] } }, { decidedBy: actorId }, { claimedBy: actorId }],
    }).select('requestId attemptNumber stageId stageName sequence status approverId claimedBy decidedBy returnedBy')
      .sort({ attemptNumber: -1, sequence: 1 }).lean(),
  ]);
  const userById = new Map(users.map((user) => [String(user._id), user]));
  const departmentById = new Map(departments.map((department) => [String(department._id), department]));
  const stepsByRequest = new Map();
  for (const step of steps) {
    const key = String(step.requestId);
    if (!stepsByRequest.has(key)) stepsByRequest.set(key, []);
    stepsByRequest.get(key).push(step);
  }
  const approverIds = [...new Set(steps.filter((step) => step.approverId).map((step) => String(step.approverId)))];
  const approvers = approverIds.length
    ? await User.find({ _id: { $in: approverIds } }).select('name').lean()
    : [];
  const approverById = new Map(approvers.map((user) => [String(user._id), user]));

  return items.map((request) => {
    const requestSteps = stepsByRequest.get(String(request._id)) || [];
    const currentAttempt = Math.max(0, ...requestSteps.map((step) => Number(step.attemptNumber)));
    const currentStep = requestSteps.find((step) =>
      ['ACTIVE', 'CLAIMED'].includes(step.status) &&
      Number(step.attemptNumber) === currentAttempt &&
      Number(step.sequence) === Number(request.currentSequence)
    );
    const acted = requestSteps.some((step) =>
      [step.decidedBy, step.returnedBy, step.claimedBy].some((id) => String(id) === String(actorId))
    );
    const assignedToActor = currentStep && (currentStep.status === 'CLAIMED'
      ? String(currentStep.claimedBy) === String(actorId)
      : String(currentStep.approverId) === String(actorId) ||
        isDelegatedForStep(requestVisibility, currentStep, request.departmentId));
    return {
      ...toPublicRequest(request),
      requester: userById.has(String(request.requesterId))
        ? { id: String(request.requesterId), ...userById.get(String(request.requesterId)) }
        : null,
      department: departmentById.has(String(request.departmentId))
        ? { id: String(request.departmentId), name: departmentById.get(String(request.departmentId)).name }
        : null,
      currentApprovalStage: currentStep ? {
        stageId: currentStep.stageId,
        stageName: currentStep.stageName,
        sequence: currentStep.sequence,
        status: currentStep.status,
        approver: currentStep.approverId
          ? {
            id: String(currentStep.approverId),
            name: approverById.get(String(currentStep.approverId))?.name || null,
          }
          : null,
        claimedBy: currentStep.claimedBy ? String(currentStep.claimedBy) : null,
      } : null,
      waitingForMe: Boolean(assignedToActor && hasEffectivePermission(
        requestVisibility.access,
        'requests.approve',
        request.departmentId
      )),
      hasActed: acted,
    };
  });
};

const assertOwnRequest = (request, userId) => {
  if (String(request.requesterId) !== String(userId)) throw new AppError('Only the request creator can perform this operation.', 403, 'REQUEST_OWNER_REQUIRED');
};

const assertPermissionForDepartment = (access, permission, departmentId) => {
  if (!hasEffectivePermission(access, permission, departmentId)) {
    throw new AppError(`Permission ${permission} is required for this operation.`, 403, 'FORBIDDEN');
  }
};

export const createRequestType = async ({ organizationId, actorId, input }) => {
  try {
    return await withTransaction(async (session) => {
      await assertActiveOrganization(organizationId, session);
      const definition = new WorkflowDefinition({
        definitionType: 'REQUEST_TYPE',
        organizationId,
        name: input.name,
        code: input.code,
        codeNormalized: normalizeCode(input.code),
        description: input.description,
        fields: input.fields,
        stages: [],
        requestType: null,
        version: 1,
        isActive: true,
        createdBy: actorId,
        updatedBy: actorId,
      });
      await definition.save({ session });
      await writeAuditLog(session, {
        organizationId, actorId, action: REQUEST_TYPE_ACTIONS.CREATED, resourceType: 'RequestType',
        resourceId: definition._id, changes: { name: definition.name, code: definition.code },
      });
      return toPublicRequestType(definition);
    });
  } catch (error) {
    throw mapDuplicateError(error);
  }
};

export const listRequestTypes = async ({ organizationId, access, includeInactive = false }) => {
  const canManage = access.organizationPermissions.has('requestTypes.manage');
  if (!canManage && !access.organizationPermissions.has('requests.create') &&
      !(access.scopedPermissions.get('requests.create')?.size || 0)) {
    throw new AppError('Permission requests.create is required for this operation.', 403, 'FORBIDDEN');
  }
  const filter = { organizationId, definitionType: 'REQUEST_TYPE' };
  if (!includeInactive || !canManage) filter.isActive = true;
  const definitions = await WorkflowDefinition.find(filter).sort({ name: 1, _id: 1 }).lean();
  return { items: definitions.map(toPublicRequestType) };
};

export const getRequestTypeById = async ({ organizationId, requestTypeId, access }) => {
  const canManage = access.organizationPermissions.has('requestTypes.manage');
  if (!canManage && !access.organizationPermissions.has('requests.create') &&
      !(access.scopedPermissions.get('requests.create')?.size || 0)) {
    throw new AppError('Permission requests.create is required for this operation.', 403, 'FORBIDDEN');
  }
  const definition = await getRequestType({ requestTypeId, organizationId });
  if (!definition.isActive && !canManage) throw new AppError('Request type not found.', 404, 'REQUEST_TYPE_NOT_FOUND');
  return toPublicRequestType(definition);
};

export const updateRequestType = async ({ organizationId, actorId, requestTypeId, input }) => {
  try {
    return await withTransaction(async (session) => {
      const definition = await getRequestType({ requestTypeId, organizationId, session });
      const changes = {};
      for (const field of ['name', 'code', 'description', 'fields']) {
        if (input[field] !== undefined) {
          changes[field] = { from: definition[field], to: input[field] };
          definition[field] = input[field];
        }
      }
      definition.updatedBy = actorId;
      await definition.save({ session });
      await writeAuditLog(session, {
        organizationId, actorId, action: REQUEST_TYPE_ACTIONS.UPDATED, resourceType: 'RequestType',
        resourceId: definition._id, changes,
      });
      return toPublicRequestType(definition);
    });
  } catch (error) {
    throw mapDuplicateError(error);
  }
};

export const setRequestTypeStatus = async ({ organizationId, actorId, requestTypeId, isActive }) =>
  withTransaction(async (session) => {
    const definition = await getRequestType({ requestTypeId, organizationId, session });
    definition.isActive = isActive;
    definition.updatedBy = actorId;
    await definition.save({ session });
    await writeAuditLog(session, {
      organizationId, actorId,
      action: isActive ? REQUEST_TYPE_ACTIONS.ACTIVATED : REQUEST_TYPE_ACTIONS.DEACTIVATED,
      resourceType: 'RequestType', resourceId: definition._id, changes: { isActive },
    });
    return toPublicRequestType(definition);
  });

export const createRequest = async ({ organizationId, actorId, access, input }) => {
  assertPermissionForDepartment(access, 'requests.create', input.departmentId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await withTransaction(async (session) => {
        await assertActiveOrganization(organizationId, session);
        await getActiveRequester({ userId: actorId, organizationId, session });
        await getDepartmentForRequester({ departmentId: input.departmentId, organizationId, userId: actorId, session });
        const definition = await getRequestType({ requestTypeId: input.requestTypeId, organizationId, session, activeOnly: true });
        validateDetails(input.details, definition);
        const amountField = getAmountField(definition);
        const request = new Request({
          organizationId,
          requestNumber: generateRequestNumber(),
          requesterId: actorId,
          departmentId: input.departmentId,
          requestTypeId: definition._id,
          requestType: definition.code,
          requestTypeCode: definition.code,
          requestTypeName: definition.name,
          title: input.title,
          description: input.description,
          priority: input.priority,
          details: input.details,
          amount: amountField ? input.details[amountField.key] : null,
          attachments: input.attachments,
          status: 'DRAFT',
        });
        await request.save({ session });
        await writeAuditLog(session, {
          organizationId, actorId, action: REQUEST_ACTIONS.CREATED, resourceType: 'Request',
          resourceId: request._id, changes: { requestNumber: request.requestNumber, status: request.status },
        });
        return toPublicRequest(request);
      });
    } catch (error) {
      if (error?.code === 11000 && attempt < 2) continue;
      throw mapDuplicateError(error);
    }
  }
  throw new AppError('Unable to generate a unique request number.', 409, 'REQUEST_NUMBER_COLLISION');
};

const getRequest = async ({ organizationId, requestId, session }) => {
  let query = Request.findOne({ _id: requestId, organizationId });
  if (session) query = query.session(session);
  const request = await query;
  if (!request) throw new AppError('Request not found.', 404, 'REQUEST_NOT_FOUND');
  return request;
};

export const getRequestById = async ({ organizationId, actorId, access, requestId }) => {
  const requestVisibility = await resolveRequestVisibility({ organizationId, actorId, access });
  const request = await Request.findOne({
    organizationId,
    _id: requestId,
    ...getRequestVisibilityFilter({ actorId, requestVisibility }),
  });
  if (!request) throw new AppError('Request not found.', 404, 'REQUEST_NOT_FOUND');
  return toPublicRequest(request);
};

export const listRequests = async ({ organizationId, actorId, access, query }) => {
  const requestVisibility = await resolveRequestVisibility({ organizationId, actorId, access });
  const filter = {
    organizationId,
    ...getRequestVisibilityFilter({ actorId, requestVisibility }),
  };
  const clauses = [];
  if (query.status) filter.status = query.status;
  if (query.requestTypeId) filter.requestTypeId = query.requestTypeId;
  if (query.departmentId) filter.departmentId = query.departmentId;
  if (query.requesterId) filter.requesterId = query.requesterId;
  if (query.priority) filter.priority = query.priority;
  if (query.approvalStage) {
    const stageRequestIds = await ApprovalStep.find({
      organizationId,
      $or: [
        { stageId: query.approvalStage },
        { stageName: { $regex: `^${escapeRegex(query.approvalStage)}$`, $options: 'i' } },
      ],
    }).distinct('requestId');
    clauses.push({ _id: { $in: stageRequestIds } });
  }
  const derivedRequestIds = await getDerivedRequestIds({
    organizationId,
    actorId,
    requestVisibility,
    derivedFilter: query.derivedFilter,
  });
  if (derivedRequestIds) clauses.push({ _id: { $in: derivedRequestIds } });
  if (query.search) {
    const expression = { $regex: escapeRegex(query.search), $options: 'i' };
    const requesterIds = await User.find({
      organizationMemberships: { $elemMatch: { organizationId, status: 'ACTIVE' } },
      $or: [{ name: expression }, { email: expression }],
    }).distinct('_id');
    clauses.push({
      $or: [
        { requestNumber: expression },
        { title: expression },
        { description: expression },
        { requesterId: { $in: requesterIds } },
      ],
    });
  }
  if (query.from || query.to) {
    filter.createdAt = {};
    if (query.from) filter.createdAt.$gte = new Date(query.from);
    if (query.to) filter.createdAt.$lte = new Date(query.to);
  }
  if (clauses.length) filter.$and = clauses;
  const sort = { [query.sortBy]: query.sortOrder === 'asc' ? 1 : -1, _id: 1 };
  const [items, total] = await Promise.all([
    Request.find(filter).sort(sort).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
    Request.countDocuments(filter),
  ]);
  const totalPages = total ? Math.ceil(total / query.limit) : 0;
  return {
    items: await enrichRequestSummaries({ items, organizationId, actorId, requestVisibility }),
    pagination: { page: query.page, limit: query.limit, total, totalPages, hasNextPage: query.page < totalPages, hasPreviousPage: query.page > 1 && total > 0 },
  };
};

export const searchRequests = async ({ organizationId, actorId, access, query }) => {
  return listRequests({
    organizationId,
    actorId,
    access,
    query: {
      ...query,
      requesterId: query.userId,
    },
  });
};

export const updateRequest = async ({ organizationId, actorId, access, requestId, input }) =>
  withTransaction(async (session) => {
    const request = await getRequest({ organizationId, requestId, session });
    assertOwnRequest(request, actorId);
    if (!['DRAFT', 'RETURNED'].includes(request.status)) {
      throw new AppError('Only draft or returned requests can be updated.', 409, 'INVALID_REQUEST_STATUS');
    }
    if (!access.organizationPermissions.has('requests.edit_own_draft') &&
        !(access.scopedPermissions.get('requests.edit_own_draft')?.has(String(request.departmentId)))) {
      throw new AppError('Permission requests.edit_own_draft is required for this operation.', 403, 'FORBIDDEN');
    }
    const nextDepartmentId = input.departmentId || String(request.departmentId);
    await getActiveRequester({ userId: actorId, organizationId, session });
    await getDepartmentForRequester({ departmentId: nextDepartmentId, organizationId, userId: actorId, session });
    const definition = await getRequestType({ requestTypeId: request.requestTypeId, organizationId, session, activeOnly: true });
    const mergedDetails = input.details === undefined
      ? request.details
      : { ...(request.details || {}), ...input.details };
    if (input.details !== undefined) validateDetails(mergedDetails, definition);
    if (input.details !== undefined) {
      const amountField = getAmountField(definition);
      request.amount = amountField ? mergedDetails[amountField.key] : null;
    }
    for (const field of ['departmentId', 'title', 'description', 'priority', 'details', 'attachments']) {
      if (field === 'details') {
        if (input.details !== undefined) request.details = mergedDetails;
      } else if (input[field] !== undefined) {
        request[field] = input[field];
      }
    }
    await request.save({ session });
    await writeAuditLog(session, {
      organizationId, actorId, action: REQUEST_ACTIONS.UPDATED, resourceType: 'Request',
      resourceId: request._id, changes: { ...input, status: request.status },
    });
    return toPublicRequest(request);
  });

export const submitRequest = async ({ organizationId, actorId, access, requestId }) =>
  withTransaction(async (session) => {
    const request = await getRequest({ organizationId, requestId, session });
    assertOwnRequest(request, actorId);
    if (!access.organizationPermissions.has('requests.submit') &&
        !(access.scopedPermissions.get('requests.submit')?.has(String(request.departmentId)))) {
      throw new AppError('Permission requests.submit is required for this operation.', 403, 'FORBIDDEN');
    }
    if (request.status !== 'DRAFT') throw new AppError('Only draft requests can be submitted.', 409, 'INVALID_REQUEST_STATUS');
    await assertActiveOrganization(organizationId, session);
    await getActiveRequester({ userId: actorId, organizationId, session });
    await getDepartmentForRequester({ departmentId: request.departmentId, organizationId, userId: actorId, session });
    const definition = await getRequestType({ requestTypeId: request.requestTypeId, organizationId, session, activeOnly: true });
    validateDetails(request.details, definition);
    const amountField = getAmountField(definition);
    request.amount = amountField ? request.details[amountField.key] : null;
    request.submittedAt = new Date();
    await createRuntimeApprovals({ organizationId, request, session, actorId });
    await writeAuditLog(session, {
      organizationId, actorId, action: REQUEST_ACTIONS.SUBMITTED, resourceType: 'Request',
      resourceId: request._id, changes: { status: request.status, submittedAt: request.submittedAt },
    });
    return toPublicRequest(request);
  });

export const resubmitRequest = async ({ organizationId, actorId, access, requestId }) =>
  withTransaction(async (session) => {
    const request = await getRequest({ organizationId, requestId, session });
    assertOwnRequest(request, actorId);
    if (request.status !== 'RETURNED') {
      throw new AppError('Only returned requests can be resubmitted.', 409, 'INVALID_REQUEST_STATUS');
    }
    if (!hasEffectivePermission(access, 'requests.submit', request.departmentId)) {
      throw new AppError('Permission requests.submit is required for this operation.', 403, 'FORBIDDEN');
    }
    await assertActiveOrganization(organizationId, session);
    await getActiveRequester({ userId: actorId, organizationId, session });
    await getDepartmentForRequester({ departmentId: request.departmentId, organizationId, userId: actorId, session });
    const definition = await getRequestType({
      requestTypeId: request.requestTypeId,
      organizationId,
      session,
      activeOnly: true,
    });
    validateDetails(request.details, definition);
    const amountField = getAmountField(definition);
    request.amount = amountField ? request.details[amountField.key] : null;
    const previousSteps = await ApprovalStep.find({ organizationId, requestId: request._id })
      .select('attemptNumber workflowDefinitionId workflowVersion')
      .sort({ attemptNumber: -1 })
      .limit(1)
      .session(session);
    const previous = previousSteps[0];
    if (!previous) throw new AppError('No previous approval cycle exists for this request.', 409, 'APPROVAL_CYCLE_NOT_FOUND');
    const attemptNumber = previous.attemptNumber + 1;
    request.submittedAt = new Date();
    request.returnedAt = null;
    request.returnedBy = null;
    request.returnReason = null;
    await createRuntimeApprovals({
      organizationId,
      request,
      session,
      actorId,
      attemptNumber,
      workflowDefinitionId: previous.workflowDefinitionId,
      workflowVersion: previous.workflowVersion,
    });
    await writeAuditLog(session, {
      organizationId,
      actorId,
      action: REQUEST_ACTIONS.RESUBMITTED,
      resourceType: 'Request',
      resourceId: request._id,
      changes: { attemptNumber, workflowVersion: previous.workflowVersion },
    });
    return toPublicRequest(request);
  });

const requestForTracking = async ({ organizationId, actorId, access, requestId }) => {
  const requestVisibility = await resolveRequestVisibility({ organizationId, actorId, access });
  const request = await Request.findOne({
    organizationId,
    _id: requestId,
    ...getRequestVisibilityFilter({ actorId, requestVisibility }),
  }).lean();
  if (!request) throw new AppError('Request not found.', 404, 'REQUEST_NOT_FOUND');
  return request;
};

export const getApprovalProgress = async ({ organizationId, actorId, access, requestId }) => {
  const request = await requestForTracking({ organizationId, actorId, access, requestId });
  const steps = await ApprovalStep.find({ organizationId, requestId })
    .sort({ attemptNumber: -1, sequence: 1, createdAt: 1 })
    .lean();
  const currentAttempt = steps[0]?.attemptNumber || 0;
  const current = steps.filter((step) => step.attemptNumber === currentAttempt);
  const sequences = [...new Set(current.map((step) => step.sequence))].sort((a, b) => a - b);
  const completed = sequences.filter((sequence) => current.filter((step) => step.sequence === sequence)
    .every((step) => ['APPROVED', 'SKIPPED', 'CANCELLED'].includes(step.status)));
  const pending = sequences.filter((sequence) => current.some((step) => ['PENDING', 'ACTIVE', 'CLAIMED'].includes(step.status)));
  const skipped = current.filter((step) => step.status === 'SKIPPED').map((step) => ({
    sequence: step.sequence,
    stageId: step.stageId,
    stageName: step.stageName,
  }));
  const active = current.find((step) => ['ACTIVE', 'CLAIMED'].includes(step.status));
  return {
    request: toPublicRequest(request),
    attemptNumber: currentAttempt,
    currentStage: active ? {
      sequence: active.sequence,
      stageId: active.stageId,
      stageName: active.stageName,
      status: active.status,
    } : null,
    totalApplicableStages: sequences.filter((sequence) => current.some((step) => step.sequence === sequence && step.status !== 'SKIPPED')).length,
    completedStages: completed,
    pendingStages: pending,
    skippedStages: skipped,
    submittedAt: request.submittedAt,
    updatedAt: request.updatedAt,
  };
};

export const getApprovalHistory = async ({ organizationId, actorId, access, requestId }) => {
  const request = await requestForTracking({ organizationId, actorId, access, requestId });
  const steps = await ApprovalStep.find({ organizationId, requestId })
    .sort({ attemptNumber: 1, sequence: 1, createdAt: 1 }).lean();
  const stepIds = steps.map((step) => step._id);
  const audits = await AuditLog.find({
    organizationId,
    resourceId: { $in: [request._id, ...stepIds] },
    resourceType: { $in: ['Request', 'Approval'] },
  }).sort({ timestamp: 1 }).lean();
  const approvalEvents = [];
  const stages = new Map();
  for (const step of steps) {
    const key = `${step.attemptNumber}:${step.sequence}:${step.stageId}`;
    const stage = stages.get(key) || [];
    stage.push(step);
    stages.set(key, stage);
  }
  for (const stageSteps of stages.values()) {
    const representative = stageSteps.find((step) => ['ACTIVE', 'CLAIMED', 'APPROVED', 'REJECTED', 'RETURNED'].includes(step.status)) || stageSteps[0];
    approvalEvents.push({
      type: 'APPROVAL_STAGE_GENERATED',
      actorId: null,
      timestamp: representative.createdAt,
      metadata: {
        attemptNumber: representative.attemptNumber,
        workflowVersion: representative.workflowVersion,
        sequence: representative.sequence,
        stageId: representative.stageId,
        stageName: representative.stageName,
        status: representative.status,
        approverType: representative.approverType,
        assignmentResolution: representative.assignmentResolution,
        approverIds: [...new Set(stageSteps.filter((step) => step.approverId).map((step) => String(step.approverId)))],
      },
    });
    for (const decision of stageSteps.filter((step) => step.decisionAt)) {
      approvalEvents.push({
        type: `APPROVAL_${decision.status}`,
        actorId: decision.decidedBy ? String(decision.decidedBy) : null,
        timestamp: decision.decisionAt,
        metadata: {
          attemptNumber: decision.attemptNumber,
          sequence: decision.sequence,
          stageId: decision.stageId,
          stageName: decision.stageName,
          approverId: decision.approverId ? String(decision.approverId) : null,
          previousStatus: decision.assignmentResolution === 'CLAIM_ONE' ? 'CLAIMED' : 'ACTIVE',
          newStatus: decision.status,
          comments: decision.comments || '',
          actedOnBehalfOf: decision.actedOnBehalfOf ? String(decision.actedOnBehalfOf) : null,
          delegationId: decision.delegationId ? String(decision.delegationId) : null,
        },
      });
    }
  }
  const stepById = new Map(steps.map((step) => [String(step._id), step]));
  const stepEvents = new Set([
    'APPROVAL_GRANTED',
    'APPROVAL_REJECTED',
    'APPROVAL_RETURNED',
  ]);
  const auditEvents = audits
    .filter((entry) => !stepEvents.has(entry.action))
    .map((entry) => {
      const step = stepById.get(String(entry.resourceId));
      return {
        type: entry.action,
        actorId: String(entry.actorId),
        timestamp: entry.timestamp,
        metadata: {
          ...(entry.changes || {}),
          ...(step ? {
            attemptNumber: step.attemptNumber,
            sequence: step.sequence,
            stageId: step.stageId,
            stageName: step.stageName,
            approverId: step.approverId ? String(step.approverId) : null,
            status: step.status,
            isOverdue: step.isOverdue,
            slaDueAt: step.slaDueAt,
            reminderCount: step.reminderCount,
            escalationLevel: step.escalationLevel,
          } : {}),
          ...(entry.action === 'APPROVAL_CLAIMED' ? {
            previousStatus: 'ACTIVE',
            newStatus: 'CLAIMED',
            claimExpiresAt: step?.claimExpiresAt || null,
            actedOnBehalfOf: step?.actedOnBehalfOf ? String(step.actedOnBehalfOf) : null,
            delegationId: step?.delegationId ? String(step.delegationId) : null,
          } : {}),
          ...(entry.action === 'APPROVAL_CLAIM_EXPIRED' ? {
            claimantId: entry.changes?.previousClaimedBy || null,
            previousStatus: 'CLAIMED',
            newStatus: 'ACTIVE',
          } : {}),
        },
      };
    });
  const timeline = [
    ...auditEvents,
    ...approvalEvents,
  ].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const userIds = [...new Set(timeline.flatMap((event) => [
    event.actorId,
    event.metadata.approverId,
    event.metadata.actedOnBehalfOf,
    event.metadata.claimantId,
    event.metadata.recipientId,
    ...(event.metadata.approverIds || []),
  ]).filter(Boolean))];
  const users = userIds.length
    ? await User.find({
      _id: { $in: userIds },
      organizationMemberships: { $elemMatch: { organizationId } },
    }).select('name').lean()
    : [];
  const userById = new Map(users.map((user) => [String(user._id), user]));
  for (const event of timeline) {
    if (event.actorId) event.actorName = userById.get(event.actorId)?.name || null;
    if (event.metadata.approverId) {
      event.metadata.approverName = userById.get(event.metadata.approverId)?.name || null;
    }
    if (event.metadata.actedOnBehalfOf) {
      event.metadata.delegatedFromName = userById.get(event.metadata.actedOnBehalfOf)?.name || null;
    }
    if (event.metadata.claimantId) {
      event.metadata.claimantName = userById.get(event.metadata.claimantId)?.name || null;
    }
    if (event.metadata.recipientId) {
      event.metadata.recipientName = userById.get(event.metadata.recipientId)?.name || null;
    }
    if (event.metadata.approverIds) {
      event.metadata.approvers = event.metadata.approverIds.map((id) => ({
        id,
        name: userById.get(id)?.name || null,
      }));
    }
  }
  return { request: toPublicRequest(request), timeline };
};

export const cancelRequest = async ({ organizationId, actorId, access, requestId, cancellationReason }) =>
  withTransaction(async (session) => {
    const request = await getRequest({ organizationId, requestId, session });
    assertOwnRequest(request, actorId);
    if (!access.organizationPermissions.has('requests.cancel_own') &&
        !(access.scopedPermissions.get('requests.cancel_own')?.has(String(request.departmentId)))) {
      throw new AppError('Permission requests.cancel_own is required for this operation.', 403, 'FORBIDDEN');
    }
    if (!['DRAFT', 'SUBMITTED', 'PENDING_APPROVAL'].includes(request.status)) throw new AppError('Only draft, submitted, or pending approval requests can be cancelled.', 409, 'INVALID_REQUEST_STATUS');
    request.status = 'CANCELLED';
    request.cancelledAt = new Date();
    request.cancelledBy = actorId;
    request.cancellationReason = cancellationReason;
    await request.save({ session });
    await cancelPendingApprovals({ organizationId, requestId: request._id, session, actorId });
    await writeAuditLog(session, {
      organizationId, actorId, action: REQUEST_ACTIONS.CANCELLED, resourceType: 'Request',
      resourceId: request._id, changes: { status: 'CANCELLED', cancellationReason },
    });
    return toPublicRequest(request);
  });

export default {
  createRequestType, listRequestTypes, getRequestTypeById, updateRequestType, setRequestTypeStatus,
  createRequest, getRequestById, listRequests, updateRequest, submitRequest, cancelRequest,
  resubmitRequest, getApprovalProgress, getApprovalHistory,
};