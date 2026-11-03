import mongoose from 'mongoose';
import { AppError } from '../../utils/AppError.js';
import { ENTITY_STATUS } from '../../config/constants.js';
import { isValidEmail, normalizeEmail } from '../auth/auth.validation.js';
import { validatePasswordStrength } from '../../utils/password.js';

const ORGANIZATION_NAME_MIN = 2;
const ORGANIZATION_NAME_MAX = 200;
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 10;
const ALLOWED_SORT_FIELDS = ['name', 'createdAt', 'updatedAt', 'status'];

export const validateObjectIdParam = (value, fieldName = 'organizationId') => {
  if (!value || !mongoose.Types.ObjectId.isValid(value)) {
    throw new AppError(`Invalid ${fieldName}.`, 400, 'VALIDATION_ERROR');
  }
  return value;
};

export const validateOrganizationName = (name) => {
  if (typeof name !== 'string') {
    throw new AppError('Organization name is required.', 400, 'VALIDATION_ERROR');
  }

  const trimmed = name.trim();
  if (!trimmed) {
    throw new AppError('Organization name is required.', 400, 'VALIDATION_ERROR');
  }
  if (trimmed.length < ORGANIZATION_NAME_MIN || trimmed.length > ORGANIZATION_NAME_MAX) {
    throw new AppError(
      `Organization name must be between ${ORGANIZATION_NAME_MIN} and ${ORGANIZATION_NAME_MAX} characters.`,
      400,
      'VALIDATION_ERROR'
    );
  }
  return trimmed;
};

export const validateCreateOrganization = (body = {}) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError('Request body must be an object.', 400, 'VALIDATION_ERROR');
  }

  const unknownFields = Object.keys(body).filter((key) => !['name', 'admin'].includes(key));
  if (unknownFields.length > 0) {
    throw new AppError('Unknown fields are not allowed.', 400, 'VALIDATION_ERROR', unknownFields);
  }

  const name = validateOrganizationName(body.name);
  const admin = body.admin && typeof body.admin === 'object' ? body.admin : {};
  const adminUnknown = Object.keys(admin).filter((key) => !['name', 'email', 'password'].includes(key));
  if (adminUnknown.length > 0) {
    throw new AppError('Unknown admin fields are not allowed.', 400, 'VALIDATION_ERROR', adminUnknown);
  }

  const adminName = typeof admin.name === 'string' ? admin.name.trim() : '';
  if (adminName.length < 2 || adminName.length > 200) {
    throw new AppError(
      'Initial admin name must be between 2 and 200 characters.',
      400,
      'VALIDATION_ERROR'
    );
  }

  const adminEmail = normalizeEmail(admin.email);
  if (!adminEmail || !isValidEmail(adminEmail)) {
    throw new AppError('A valid initial admin email is required.', 400, 'VALIDATION_ERROR');
  }

  if (typeof admin.password !== 'string' || admin.password.length === 0) {
    throw new AppError('Initial admin password is required.', 400, 'VALIDATION_ERROR');
  }
  validatePasswordStrength(admin.password);

  return {
    name,
    admin: {
      name: adminName,
      email: adminEmail,
      password: admin.password,
    },
  };
};

export const validateUpdateOrganization = (body = {}) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError('Request body must be an object.', 400, 'VALIDATION_ERROR');
  }

  const unknownFields = Object.keys(body).filter((key) => key !== 'name');
  if (unknownFields.length > 0) {
    throw new AppError('Only the organization name can be updated.', 400, 'VALIDATION_ERROR', unknownFields);
  }
  return {
    name: validateOrganizationName(body.name),
  };
};

export const validateOrganizationListQuery = (query = {}) => {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw new AppError('Query parameters must be an object.', 400, 'VALIDATION_ERROR');
  }

  const unknownFields = Object.keys(query).filter(
    (key) => !['page', 'limit', 'search', 'status', 'sortBy', 'sortOrder'].includes(key)
  );
  if (unknownFields.length > 0) {
    throw new AppError('Unknown query parameters are not allowed.', 400, 'VALIDATION_ERROR', unknownFields);
  }

  const page = query.page === undefined || query.page === '' ? 1 : Number(query.page);
  const limit = query.limit === undefined || query.limit === '' ? DEFAULT_PAGE_SIZE : Number(query.limit);

  if ((query.page !== undefined && typeof query.page !== 'string') || !Number.isInteger(page) || page < 1) {
    throw new AppError('page must be a positive integer.', 400, 'VALIDATION_ERROR');
  }
  if ((query.limit !== undefined && typeof query.limit !== 'string') || !Number.isInteger(limit) || limit < 1) {
    throw new AppError('limit must be a positive integer.', 400, 'VALIDATION_ERROR');
  }
  if (limit > MAX_PAGE_SIZE) {
    throw new AppError(`limit cannot exceed ${MAX_PAGE_SIZE}.`, 400, 'VALIDATION_ERROR');
  }

  let status;
  if (query.status !== undefined && query.status !== '') {
    if (typeof query.status !== 'string' || !ENTITY_STATUS.includes(query.status)) {
      throw new AppError('status must be ACTIVE or INACTIVE.', 400, 'VALIDATION_ERROR');
    }
    status = query.status;
  }

  if (query.search !== undefined && typeof query.search !== 'string') {
    throw new AppError('search must be a string.', 400, 'VALIDATION_ERROR');
  }
  const search = query.search ? query.search.trim() : '';
  const sortBy = query.sortBy || 'createdAt';
  if (typeof sortBy !== 'string' || !ALLOWED_SORT_FIELDS.includes(sortBy)) {
    throw new AppError('Invalid sortBy field.', 400, 'VALIDATION_ERROR');
  }

  if (query.sortOrder !== undefined && typeof query.sortOrder !== 'string') {
    throw new AppError('sortOrder must be asc or desc.', 400, 'VALIDATION_ERROR');
  }
  const sortOrder = (query.sortOrder || 'desc').toLowerCase();
  if (!['asc', 'desc'].includes(sortOrder)) {
    throw new AppError('sortOrder must be asc or desc.', 400, 'VALIDATION_ERROR');
  }

  return { page, limit, search, status, sortBy, sortOrder };
};

export default {
  validateObjectIdParam,
  validateOrganizationName,
  validateCreateOrganization,
  validateUpdateOrganization,
  validateOrganizationListQuery,
};
