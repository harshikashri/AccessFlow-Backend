import mongoose from 'mongoose';
import { AppError } from '../../utils/AppError.js';

const fail = (message) => { throw new AppError(message, 400, 'VALIDATION_ERROR'); };
const id = (value, label) => {
  if (!mongoose.Types.ObjectId.isValid(value)) fail(`Invalid ${label}.`);
  return new mongoose.Types.ObjectId(value).toString();
};

export const validateDelegation = (body = {}) => {
  const allowed = ['delegateId', 'scopeType', 'departmentId', 'stageIds', 'startsAt', 'endsAt'];
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new AppError('Unsupported delegation fields.', 400, 'VALIDATION_ERROR', unknown);
  const startsAt = new Date(body.startsAt);
  const endsAt = new Date(body.endsAt);
  if (!body.startsAt || Number.isNaN(startsAt.getTime()) || !body.endsAt || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) {
    fail('Delegation end date must be later than its start date.');
  }
  if (!['ORGANIZATION', 'DEPARTMENT'].includes(body.scopeType || 'ORGANIZATION')) fail('Invalid delegation scope.');
  if (body.scopeType === 'DEPARTMENT' && !body.departmentId) fail('Department scope requires departmentId.');
  if (body.stageIds !== undefined && (!Array.isArray(body.stageIds) || body.stageIds.some((item) => typeof item !== 'string' || !item.trim()))) {
    fail('stageIds must be an array of non-empty strings.');
  }
  return {
    delegateId: id(body.delegateId, 'delegateId'),
    scopeType: body.scopeType || 'ORGANIZATION',
    departmentId: body.departmentId ? id(body.departmentId, 'departmentId') : null,
    stageIds: body.stageIds || [],
    startsAt,
    endsAt,
  };
};

export const validateDelegationId = (value) => id(value, 'delegationId');
