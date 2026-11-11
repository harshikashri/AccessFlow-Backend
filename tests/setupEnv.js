import { inject } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT || '5000';
process.env.MONGODB_URI = inject('accessflowMongoUri');
if (!process.env.MONGODB_URI) {
  throw new Error('The isolated MongoDB replica set was not provided to the test environment.');
}
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET || 'test_access_secret_please_change_32';
process.env.JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET || 'test_refresh_secret_please_change_32';
process.env.ACCESS_TOKEN_EXPIRY = process.env.ACCESS_TOKEN_EXPIRY || '15m';
process.env.REFRESH_TOKEN_EXPIRY = process.env.REFRESH_TOKEN_EXPIRY || '7d';
process.env.CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';
process.env.COOKIE_SECURE = 'false';
process.env.COOKIE_SAME_SITE = 'lax';
process.env.COOKIE_PATH = '/api/auth';
process.env.BCRYPT_SALT_ROUNDS = process.env.BCRYPT_SALT_ROUNDS || '4';
process.env.AUTH_RATE_LIMIT_WINDOW_MS = '900000';
process.env.AUTH_RATE_LIMIT_MAX = '10000';
process.env.EMAIL_PROVIDER = 'resend';
process.env.RESEND_API_KEY = 'test_resend_key';
process.env.EMAIL_FROM = 'AccessFlow <onboarding@resend.dev>';
process.env.EMAIL_TEST_MODE = 'true';
process.env.EMAIL_TEST_RECIPIENT = 'email-test@example.com';
