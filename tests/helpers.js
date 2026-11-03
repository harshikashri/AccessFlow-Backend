import mongoose from 'mongoose';
import request from 'supertest';
import app from '../src/app.js';
import { connectDatabase, initializeDatabase } from '../src/config/db.js';
import User from '../src/models/User.js';
import Session from '../src/models/Session.js';
import { hashPassword } from '../src/utils/password.js';

export const TEST_PASSWORD = 'StrongPass1!';

export const connectTestDatabase = async () => {
  await connectDatabase();
  if (!mongoose.connection.name.includes('accessflow_test')) {
    throw new Error(`Refusing to run tests against database: ${mongoose.connection.name}`);
  }
};

export const resetTestDatabase = async () => {
  if (!mongoose.connection.name.includes('accessflow_test')) {
    throw new Error(`Refusing to drop database: ${mongoose.connection.name}`);
  }
  await mongoose.connection.dropDatabase();
  await initializeDatabase();
};

export const disconnectTestDatabase = async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
};

export const createUser = async (overrides = {}) => {
  const passwordHash = await hashPassword(overrides.password || TEST_PASSWORD);
  const {
    password,
    ...rest
  } = overrides;

  return User.create({
    name: rest.name || 'Test User',
    email: rest.email || `user-${Date.now()}@example.com`,
    passwordHash,
    accountStatus: rest.accountStatus || 'ACTIVE',
    platformRole: rest.platformRole ?? null,
    organizationMemberships: rest.organizationMemberships || [],
  });
};

export const createSuperAdmin = async (overrides = {}) =>
  createUser({
    name: overrides.name || 'Super Admin',
    email: overrides.email || 'superadmin@example.com',
    platformRole: 'SUPER_ADMIN',
    organizationMemberships: [],
    ...overrides,
  });

export const loginRequest = (payload) =>
  request(app).post('/api/auth/login').send(payload);

export const extractRefreshCookie = (response) => {
  const cookies = response.headers['set-cookie'];
  if (!cookies) {
    return null;
  }
  const list = Array.isArray(cookies) ? cookies : [cookies];
  const refresh = list.find((item) => item.startsWith('refreshToken='));
  return refresh || null;
};

export const getCookieValue = (setCookieHeader) => {
  if (!setCookieHeader) {
    return null;
  }
  const match = String(setCookieHeader).match(/^refreshToken=([^;]+)/);
  return match ? match[1] : null;
};

export { app, request, User, Session };
