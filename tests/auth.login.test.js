import crypto from 'crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  TEST_PASSWORD,
  connectTestDatabase,
  createSuperAdmin,
  createUser,
  disconnectTestDatabase,
  extractRefreshCookie,
  getCookieValue,
  loginRequest,
  resetTestDatabase,
  Session,
} from './helpers.js';
import Organization from '../src/models/Organization.js';
import { hashToken } from '../src/utils/token.js';

describe('Auth login', () => {
  beforeAll(async () => {
    await connectTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await disconnectTestDatabase();
  });

  it('logs in Super Admin with correct credentials', async () => {
    await createSuperAdmin({ email: 'admin@example.com' });

    const response = await loginRequest({
      email: 'admin@example.com',
      password: TEST_PASSWORD,
    });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.accessToken).toBeTruthy();
    expect(response.body.data.user).toMatchObject({
      email: 'admin@example.com',
      platformRole: 'SUPER_ADMIN',
      organizationId: null,
    });
    expect(response.body.data.user.passwordHash).toBeUndefined();
    expect(response.body.data.refreshToken).toBeUndefined();

    const cookie = extractRefreshCookie(response);
    expect(cookie).toBeTruthy();
    expect(cookie.toLowerCase()).toContain('httponly');

    const sessions = await Session.find({});
    expect(sessions).toHaveLength(1);
    expect(sessions[0].organizationId).toBeNull();

    const rawRefresh = getCookieValue(cookie);
    expect(sessions[0].refreshTokenHash).not.toBe(rawRefresh);
    expect(sessions[0].refreshTokenHash).toBe(hashToken(rawRefresh));
  });

  it('rejects incorrect password with generic message', async () => {
    await createSuperAdmin({ email: 'admin@example.com' });

    const response = await loginRequest({
      email: 'admin@example.com',
      password: 'WrongPass1!',
    });

    expect(response.status).toBe(401);
    expect(response.body.message).toBe('Invalid email or password.');
    expect(await Session.countDocuments()).toBe(0);
  });

  it('rejects unknown email with generic message', async () => {
    const response = await loginRequest({
      email: 'missing@example.com',
      password: TEST_PASSWORD,
    });

    expect(response.status).toBe(401);
    expect(response.body.message).toBe('Invalid email or password.');
  });

  it('rejects inactive users even with correct password', async () => {
    await createSuperAdmin({
      email: 'inactive@example.com',
      accountStatus: 'INACTIVE',
    });

    const response = await loginRequest({
      email: 'inactive@example.com',
      password: TEST_PASSWORD,
    });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('ACCOUNT_INACTIVE');
    expect(await Session.countDocuments()).toBe(0);
  });

  it('rejects login before first-time password setup is complete', async () => {
    const user = await createUser({ email: 'pending-setup@example.com' });
    user.passwordSetupRequired = true;
    await user.save();

    const response = await loginRequest({
      email: user.email,
      password: TEST_PASSWORD,
    });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('PASSWORD_SETUP_REQUIRED');
    expect(await Session.countDocuments({ userId: user._id })).toBe(0);
  });

  it('requires organization selection for multi-org users', async () => {
    const orgA = new mongoose.Types.ObjectId();
    const orgB = new mongoose.Types.ObjectId();

    const user = await createUser({
      email: 'multi@example.com',
      organizationMemberships: [
        { organizationId: orgA, status: 'ACTIVE' },
        { organizationId: orgB, status: 'ACTIVE' },
      ],
    });
    await Organization.create([
      { _id: orgA, name: 'Multi Org A', createdBy: user._id },
      { _id: orgB, name: 'Multi Org B', createdBy: user._id },
    ]);

    const missingOrg = await loginRequest({
      email: 'multi@example.com',
      password: TEST_PASSWORD,
    });
    expect(missingOrg.status).toBe(400);
    expect(missingOrg.body.code).toBe('ORGANIZATION_SELECTION_REQUIRED');

    const withOrg = await loginRequest({
      email: 'multi@example.com',
      password: TEST_PASSWORD,
      organizationId: String(orgB),
    });
    expect(withOrg.status).toBe(200);
    expect(withOrg.body.data.user.organizationId).toBe(String(orgB));
  });

  it('rejects arbitrary organizationId not belonging to the user', async () => {
    const orgA = new mongoose.Types.ObjectId();
    await createUser({
      email: 'single@example.com',
      organizationMemberships: [{ organizationId: orgA, status: 'ACTIVE' }],
    });

    const response = await loginRequest({
      email: 'single@example.com',
      password: TEST_PASSWORD,
      organizationId: String(new mongoose.Types.ObjectId()),
    });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('INVALID_ORGANIZATION_CONTEXT');
  });
});
