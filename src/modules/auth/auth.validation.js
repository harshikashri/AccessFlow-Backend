import mongoose from 'mongoose';
import { AppError } from '../../utils/AppError.js';

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

export default {
  normalizeEmail,
  validateLoginInput,
  isValidEmail,
};
