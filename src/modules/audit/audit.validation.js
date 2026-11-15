import mongoose from 'mongoose';
import { AppError } from '../../utils/AppError.js';

const allowedActions = (value) => {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 200) {
    throw new AppError('Invalid audit action.', 400, 'VALIDATION_ERROR');
  }
  return value.trim();
};

const objectId = (value, label) => {
  if (value === undefined || value === '') return undefined;
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new AppError(`Invalid ${label}.`, 400, 'VALIDATION_ERROR');
  }
  return String(value);
};

const date = (value, label) => {
  if (value === undefined || value === '') return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(`Invalid ${label}.`, 400, 'VALIDATION_ERROR');
  }
  return parsed;
};

export const validateAuditListQuery = (query = {}) => {
  const page = Number(query.page || 1);
  const limit = Number(query.limit || 25);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new AppError('Invalid pagination.', 400, 'VALIDATION_ERROR');
  }
  const sortBy = ['timestamp', 'action', 'resourceType', 'result', 'status'].includes(query.sortBy)
    ? query.sortBy
    : 'timestamp';
  const sortOrder = query.sortOrder === 'asc' ? 'asc' : 'desc';
  return {
    page,
    limit,
    search: typeof query.search === 'string' ? query.search.trim().slice(0, 200) : undefined,
    actorId: objectId(query.actorId, 'actorId'),
    action: allowedActions(query.action),
    resourceType: allowedActions(query.resourceType),
    resourceId: objectId(query.resourceId, 'resourceId'),
    organizationId: objectId(query.organizationId, 'organizationId'),
    departmentId: objectId(query.departmentId, 'departmentId'),
    result: allowedActions(query.result),
    status: allowedActions(query.status),
    fromDate: date(query.fromDate, 'fromDate'),
    toDate: date(query.toDate, 'toDate'),
    sortBy,
    sortOrder,
  };
};

export const validateAuditId = (value) => objectId(value, 'auditLogId');
