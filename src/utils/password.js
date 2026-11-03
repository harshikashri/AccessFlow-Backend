import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';
import { AppError } from './AppError.js';

const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_RULES = [
  { test: /[a-z]/, message: 'Password must include at least one lowercase letter.' },
  { test: /[A-Z]/, message: 'Password must include at least one uppercase letter.' },
  { test: /\d/, message: 'Password must include at least one number.' },
  {
    test: /[^A-Za-z0-9]/,
    message: 'Password must include at least one special character.',
  },
];

export const validatePasswordStrength = (password) => {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    throw new AppError(
      `Password must be at least ${PASSWORD_MIN_LENGTH} characters long.`,
      400,
      'WEAK_PASSWORD'
    );
  }

  for (const rule of PASSWORD_RULES) {
    if (!rule.test.test(password)) {
      throw new AppError(rule.message, 400, 'WEAK_PASSWORD');
    }
  }
};

export const hashPassword = async (password) => {
  validatePasswordStrength(password);
  return bcrypt.hash(password, env.BCRYPT_SALT_ROUNDS);
};

export const verifyPassword = async (password, passwordHash) => {
  if (!password || !passwordHash) {
    return false;
  }
  return bcrypt.compare(password, passwordHash);
};

export default {
  validatePasswordStrength,
  hashPassword,
  verifyPassword,
};
