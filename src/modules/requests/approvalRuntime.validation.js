import mongoose from 'mongoose';
import { AppError } from '../../utils/AppError.js';

export const validateApprovalStepId = (value) => {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new AppError('Invalid approvalStepId.', 400, 'VALIDATION_ERROR');
  }
  return new mongoose.Types.ObjectId(value).toString();
};

export const validateApprovalComment = (body = {}) => {
  const unknown = Object.keys(body).filter((key) => key !== 'comment');
  if (unknown.length) throw new AppError('Unsupported approval fields.', 400, 'VALIDATION_ERROR', unknown);
  if (body.comment !== undefined && (typeof body.comment !== 'string' || body.comment.length > 2000)) {
    throw new AppError('Approval comment must be at most 2000 characters.', 400, 'VALIDATION_ERROR');
  }
  return body.comment?.trim() || '';
};

export const validateReturnReason = (body = {}) => {
  const unknown = Object.keys(body).filter((key) => key !== 'reason' && key !== 'comment');
  if (unknown.length) throw new AppError('Unsupported return fields.', 400, 'VALIDATION_ERROR', unknown);
  const value = body.reason ?? body.comment;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 2000) {
    throw new AppError('A return reason is required and must be at most 2000 characters.', 400, 'VALIDATION_ERROR');
  }
  return value.trim();
};

export const validateApprovalInboxQuery = (query = {}) => {
  const allowed = [
    'status', 'category', 'requestId', 'requestNumber', 'requestTypeId', 'departmentId',
    'requesterId', 'approvalMode', 'stageId', 'fromDate', 'toDate', 'page', 'limit',
    'sortBy', 'sortOrder',
  ];
  const unknown = Object.keys(query).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new AppError('Unknown approval inbox query parameters are not allowed.', 400, 'VALIDATION_ERROR', unknown);
  const parseId = (value, name) => {
    if (value === undefined) return undefined;
    if (!mongoose.Types.ObjectId.isValid(value)) throw new AppError(`Invalid ${name}.`, 400, 'VALIDATION_ERROR');
    return new mongoose.Types.ObjectId(value);
  };
  const parseInteger = (value, fallback, max) => {
    if (value === undefined || value === '') return fallback;
    if (!/^\d+$/.test(value)) throw new AppError('Pagination values must be positive integers.', 400, 'VALIDATION_ERROR');
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw new AppError('Pagination value is out of range.', 400, 'VALIDATION_ERROR');
    return parsed;
  };
  const page = parseInteger(query.page, 1, Number.MAX_SAFE_INTEGER);
  const limit = parseInteger(query.limit, 10, 100);
  if (query.status && !['PENDING', 'ACTIVE', 'CLAIMED', 'APPROVED', 'REJECTED', 'RETURNED', 'SKIPPED', 'CANCELLED'].includes(query.status)) {
    throw new AppError('Invalid approval status.', 400, 'VALIDATION_ERROR');
  }
  if (query.category && !['available', 'assigned', 'pending_action', 'completed', 'all'].includes(query.category)) {
    throw new AppError('Invalid approval category.', 400, 'VALIDATION_ERROR');
  }
  if (query.approvalMode && !['ANY', 'ALL'].includes(query.approvalMode)) throw new AppError('Invalid approval mode.', 400, 'VALIDATION_ERROR');
  const sortBy = query.sortBy || 'createdAt';
  if (!['createdAt', 'updatedAt', 'decisionAt', 'sequence', 'status'].includes(sortBy)) throw new AppError('Invalid sortBy field.', 400, 'VALIDATION_ERROR');
  const sortOrder = (query.sortOrder || 'desc').toLowerCase();
  if (!['asc', 'desc'].includes(sortOrder)) throw new AppError('sortOrder must be asc or desc.', 400, 'VALIDATION_ERROR');
  for (const [name, value] of [['fromDate', query.fromDate], ['toDate', query.toDate]]) {
    if (value !== undefined && Number.isNaN(Date.parse(value))) throw new AppError(`${name} must be a valid date.`, 400, 'VALIDATION_ERROR');
  }
  if (query.fromDate && query.toDate && new Date(query.fromDate) > new Date(query.toDate)) {
    throw new AppError('fromDate must be before toDate.', 400, 'VALIDATION_ERROR');
  }
  return {
    ...query,
    page,
    limit,
    requestId: parseId(query.requestId, 'requestId'),
    requestTypeId: parseId(query.requestTypeId, 'requestTypeId'),
    departmentId: parseId(query.departmentId, 'departmentId'),
    requesterId: parseId(query.requesterId, 'requesterId'),
    sortBy,
    sortOrder,
  };
};
