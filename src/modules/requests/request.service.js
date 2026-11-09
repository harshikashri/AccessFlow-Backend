import crypto from 'node:crypto';
import mongoose from 'mongoose';
import Request from '../../models/Request.js';
import WorkflowDefinition from '../../models/WorkflowDefinition.js';
import Organization from '../../models/Organization.js';
import Department from '../../models/Department.js';
import User from '../../models/User.js';
import AuditLog from '../../models/AuditLog.js';
import { hasEffectivePermission } from '../../services/authorization/permission.service.js';
import { AppError } from '../../utils/AppError.js';
import { withTransaction } from '../../utils/transaction.js';
import { REQUEST_ACTIONS, REQUEST_TYPE_ACTIONS } from './request.constants.js';
import { escapeRegex, normalizeCode, toPublicRequest, toPublicRequestType } from './request.utils.js';
import { evaluateFields } from './request.conditions.js';

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

const getAmountField = (definition) =>
  (definition.fields || []).find((field) => field.semantic === 'AMOUNT') || null;

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
    (assignment) => assignment.scopeType === 'ORGANIZATION' &&
      assignment.roleId?.roleType === 'ORGANIZATION_ADMIN'
  );
  const managedDepartmentIds = new Set(
    (await Department.find({
      organizationId,
      status: 'ACTIVE',
      managerIds: actorId,
    }).distinct('_id')).map(String)
  );
  return { isOrganizationAdmin, managedDepartmentIds };
};

const getSubmittedVisibilityFilter = () => ({
  $or: [
    { status: 'SUBMITTED' },
    { status: 'CANCELLED', submittedAt: { $ne: null } },
  ],
});

const getRequestVisibilityFilter = ({ actorId, requestVisibility }) => {
  const owner = { requesterId: actorId };
  if (requestVisibility.isOrganizationAdmin) {
    return { $or: [owner, getSubmittedVisibilityFilter()] };
  }
  if (requestVisibility.managedDepartmentIds.size) {
    return {
      $or: [
        owner,
        {
          $and: [
            { departmentId: { $in: [...requestVisibility.managedDepartmentIds] } },
            getSubmittedVisibilityFilter(),
          ],
        },
      ],
    };
  }
  return owner;
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
  if (query.status) filter.status = query.status;
  if (query.requestTypeId) filter.requestTypeId = query.requestTypeId;
  if (query.departmentId) filter.departmentId = query.departmentId;
  if (query.priority) filter.priority = query.priority;
  if (query.search) {
    const expression = { $regex: escapeRegex(query.search), $options: 'i' };
    filter.$and = [{ $or: [{ requestNumber: expression }, { title: expression }, { description: expression }] }];
  }
  if (query.from || query.to) {
    filter.createdAt = {};
    if (query.from) filter.createdAt.$gte = new Date(query.from);
    if (query.to) filter.createdAt.$lte = new Date(query.to);
  }
  const sort = { [query.sortBy]: query.sortOrder === 'asc' ? 1 : -1, _id: 1 };
  const [items, total] = await Promise.all([
    Request.find(filter).sort(sort).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
    Request.countDocuments(filter),
  ]);
  const totalPages = total ? Math.ceil(total / query.limit) : 0;
  return {
    items: items.map(toPublicRequest),
    pagination: { page: query.page, limit: query.limit, total, totalPages, hasNextPage: query.page < totalPages, hasPreviousPage: query.page > 1 && total > 0 },
  };
};

export const searchRequests = async ({ organizationId, actorId, access, query }) => {
  const requestVisibility = await resolveRequestVisibility({ organizationId, actorId, access });
  const filter = {
    organizationId,
    ...getRequestVisibilityFilter({ actorId, requestVisibility }),
  };
  if (query.status) filter.status = query.status;
  if (query.requestTypeId) filter.requestTypeId = query.requestTypeId;
  if (query.departmentId) filter.departmentId = query.departmentId;
  if (query.userId) filter.requesterId = query.userId;
  const sort = { [query.sortBy]: query.sortOrder === 'asc' ? 1 : -1, _id: 1 };
  const [items, total] = await Promise.all([
    Request.find(filter).sort(sort).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
    Request.countDocuments(filter),
  ]);
  const totalPages = total ? Math.ceil(total / query.limit) : 0;
  return {
    items: items.map(toPublicRequest),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages,
      hasNextPage: query.page < totalPages,
      hasPreviousPage: query.page > 1 && total > 0,
    },
  };
};

export const updateRequest = async ({ organizationId, actorId, access, requestId, input }) =>
  withTransaction(async (session) => {
    const request = await getRequest({ organizationId, requestId, session });
    assertOwnRequest(request, actorId);
    if (request.status !== 'DRAFT') throw new AppError('Only draft requests can be updated.', 409, 'INVALID_REQUEST_STATUS');
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
      resourceId: request._id, changes: input,
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
    request.status = 'SUBMITTED';
    request.submittedAt = new Date();
    await request.save({ session });
    await writeAuditLog(session, {
      organizationId, actorId, action: REQUEST_ACTIONS.SUBMITTED, resourceType: 'Request',
      resourceId: request._id, changes: { status: 'SUBMITTED', submittedAt: request.submittedAt },
    });
    return toPublicRequest(request);
  });

export const cancelRequest = async ({ organizationId, actorId, access, requestId, cancellationReason }) =>
  withTransaction(async (session) => {
    const request = await getRequest({ organizationId, requestId, session });
    assertOwnRequest(request, actorId);
    if (!access.organizationPermissions.has('requests.cancel_own') &&
        !(access.scopedPermissions.get('requests.cancel_own')?.has(String(request.departmentId)))) {
      throw new AppError('Permission requests.cancel_own is required for this operation.', 403, 'FORBIDDEN');
    }
    if (!['DRAFT', 'SUBMITTED'].includes(request.status)) throw new AppError('Only draft or submitted requests can be cancelled.', 409, 'INVALID_REQUEST_STATUS');
    request.status = 'CANCELLED';
    request.cancelledAt = new Date();
    request.cancelledBy = actorId;
    request.cancellationReason = cancellationReason;
    await request.save({ session });
    await writeAuditLog(session, {
      organizationId, actorId, action: REQUEST_ACTIONS.CANCELLED, resourceType: 'Request',
      resourceId: request._id, changes: { status: 'CANCELLED', cancellationReason },
    });
    return toPublicRequest(request);
  });

export default {
  createRequestType, listRequestTypes, getRequestTypeById, updateRequestType, setRequestTypeStatus,
  createRequest, getRequestById, listRequests, updateRequest, submitRequest, cancelRequest,
};