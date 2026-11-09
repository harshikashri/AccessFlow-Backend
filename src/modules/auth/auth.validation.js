import mongoose from 'mongoose';
import { AppError } from '../../utils/AppError.js';
import { validatePasswordStrength } from '../../utils/password.js';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const normalizeEmail = (email) => {
  if (typeof email !== 'string') {
    return '';
  }
  return email.trim().toLowerCase();
};

export const validateLoginInput = (body = {}) => {
  const email = normalizeEmail(body.email);
  const password = body.password;
  const organizationId = body.organizationId;

  if (!email || !EMAIL_REGEX.test(email)) {
    throw new AppError('A valid email is required.', 400, 'VALIDATION_ERROR');
  }

  if (typeof password !== 'string' || password.length === 0) {
    throw new AppError('Password is required.', 400, 'VALIDATION_ERROR');
  }

  let parsedOrganizationId;
  if (organizationId !== undefined && organizationId !== null && organizationId !== '') {
    if (!mongoose.Types.ObjectId.isValid(organizationId)) {
      throw new AppError('Invalid organizationId.', 400, 'VALIDATION_ERROR');
    }
    parsedOrganizationId = String(organizationId);
  }

  return {
    email,
    password,
    organizationId: parsedOrganizationId,
  };
};

export const isValidEmail = (email) => EMAIL_REGEX.test(normalizeEmail(email));

const requireObject = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError('Request body must be an object.', 400, 'VALIDATION_ERROR');
  }
};

const validateOneTimePasswordToken = (body) => {
  requireObject(body);
  const unknownFields = Object.keys(body).filter(
    (field) => !['token', 'password', 'confirmPassword'].includes(field)
  );
  if (unknownFields.length) {
    throw new AppError('Unsupported fields.', 400, 'VALIDATION_ERROR', unknownFields);
  }
  if (typeof body.token !== 'string' || body.token.length < 32 || body.token.length > 256) {
    throw new AppError('A valid token is required.', 400, 'VALIDATION_ERROR');
  }
  if (body.password !== body.confirmPassword) {
    throw new AppError('Password and confirmation do not match.', 400, 'VALIDATION_ERROR');
  }
  validatePasswordStrength(body.password);
  return { token: body.token, password: body.password };
};

export const validateSetPasswordInput = validateOneTimePasswordToken;
export const validateResetPasswordInput = validateOneTimePasswordToken;
export const validateForgotPasswordInput = (body) => {
  requireObject(body);
  const unknownFields = Object.keys(body).filter((field) => field !== 'email');
  if (unknownFields.length) {
    throw new AppError('Only email is allowed.', 400, 'VALIDATION_ERROR', unknownFields);
  }
  const email = normalizeEmail(body.email);
  if (!email || email.length > 320 || !isValidEmail(email)) {
    throw new AppError('A valid email is required.', 400, 'VALIDATION_ERROR');
  }
  return { email };
};

export default {
  normalizeEmail,
  validateLoginInput,
  isValidEmail,
  validateSetPasswordInput,
  validateForgotPasswordInput,
  validateResetPasswordInput,
};
