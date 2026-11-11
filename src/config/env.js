import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const requiredEnv = [
  'PORT',
  'NODE_ENV',
  'MONGODB_URI',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'ACCESS_TOKEN_EXPIRY',
  'REFRESH_TOKEN_EXPIRY',
  'CLIENT_URL',
];

for (const key of requiredEnv) {
  if (!process.env[key] || process.env[key].trim() === '') {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const parseBoolean = (value, fallback) => {
  if (value === undefined || value === null || value.trim() === '') {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
};

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const env = {
  PORT: Number(process.env.PORT) || 5000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  MONGODB_URI: process.env.MONGODB_URI,
  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET,
  // Kept for compatibility; refresh tokens are opaque and hashed, not JWTs.
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
  ACCESS_TOKEN_EXPIRY: process.env.ACCESS_TOKEN_EXPIRY,
  REFRESH_TOKEN_EXPIRY: process.env.REFRESH_TOKEN_EXPIRY,
  CLIENT_URL: process.env.CLIENT_URL,
  COOKIE_SECURE: parseBoolean(process.env.COOKIE_SECURE, process.env.NODE_ENV === 'production'),
  COOKIE_SAME_SITE: (process.env.COOKIE_SAME_SITE || 'lax').toLowerCase(),
  COOKIE_DOMAIN: process.env.COOKIE_DOMAIN?.trim() || undefined,
  COOKIE_PATH: process.env.COOKIE_PATH?.trim() || '/api/auth',
  BCRYPT_SALT_ROUNDS: parsePositiveInt(process.env.BCRYPT_SALT_ROUNDS, 12),
  AUTH_RATE_LIMIT_WINDOW_MS: parsePositiveInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
  AUTH_RATE_LIMIT_MAX: parsePositiveInt(process.env.AUTH_RATE_LIMIT_MAX, 20),
  EMAIL_PROVIDER: process.env.EMAIL_PROVIDER?.trim().toLowerCase() || '',
  RESEND_API_KEY: process.env.RESEND_API_KEY?.trim() || '',
  EMAIL_FROM: process.env.EMAIL_FROM?.trim() || '',
  EMAIL_TEST_MODE: parseBoolean(process.env.EMAIL_TEST_MODE, false),
  EMAIL_TEST_RECIPIENT: process.env.EMAIL_TEST_RECIPIENT?.trim().toLowerCase() || '',
  APPROVAL_WORKER_ENABLED: parseBoolean(process.env.APPROVAL_WORKER_ENABLED, process.env.NODE_ENV !== 'test'),
  APPROVAL_WORKER_INTERVAL_MS: parsePositiveInt(process.env.APPROVAL_WORKER_INTERVAL_MS, 60 * 1000),
  SUPER_ADMIN_NAME: process.env.SUPER_ADMIN_NAME?.trim() || '',
  SUPER_ADMIN_EMAIL: process.env.SUPER_ADMIN_EMAIL?.trim() || '',
  SUPER_ADMIN_PASSWORD: process.env.SUPER_ADMIN_PASSWORD || '',
};

export default env;
