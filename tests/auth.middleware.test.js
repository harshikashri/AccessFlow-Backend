import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import {
  TEST_PASSWORD,
  app,
  connectTestDatabase,
  createSuperAdmin,
  createUser,
  disconnectTestDatabase,
  loginRequest,
  request,
  resetTestDatabase,
  Session,
} from './helpers.js';

const authHeader = (token) => ({ Authorization: `Bearer ${token}` });

describe('Authentication middleware', () => {
  beforeAll(async () => {
    await connectTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await disconnectTestDatabase();
  });

  const loginSuperAdmin = async () => {
    await createSuperAdmin({ email: 'middleware@example.com' });
    const response = await loginRequest({
      email: 'middleware@example.com',
      password: TEST_PASSWORD,
    });
    return response.body.data.accessToken;
  };

  it('accepts a valid access token', async () => {
    const token = await loginSuperAdmin();
    const response = await request(app).get('/api/auth/me').set(authHeader(token));
    expect(response.status).toBe(200);
    expect(response.body.data.user.platformRole).toBe('SUPER_ADMIN');
    expect(response.body.data.user.organizationId).toBeNull();
  });

  it('rejects missing token', async () => {
    const response = await request(app).get('/api/auth/me');
    expect(response.status).toBe(401);
  });

  it('rejects invalid token', async () => {
    const response = await request(app)
      .get('/api/auth/me')
      .set(authHeader('not.a.valid.token'));
    expect(response.status).toBe(401);
  });

  it('rejects expired token', async () => {
    await createSuperAdmin({ email: 'expired-token@example.com' });
    const login = await loginRequest({
      email: 'expired-token@example.com',
      password: TEST_PASSWORD,
    });
    const session = await Session.findOne({});
    const expired = jwt.sign(
      {
        userId: String(session.userId),
        sessionId: String(session._id),
        organizationId: null,
        platformRole: 'SUPER_ADMIN',
      },
      env.JWT_ACCESS_SECRET,
      { expiresIn: -10 }
    );

    const response = await request(app).get('/api/auth/me').set(authHeader(expired));
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('TOKEN_EXPIRED');
  });

  it('rejects missing session', async () => {
    const token = await loginSuperAdmin();
    await Session.deleteMany({});
    const response = await request(app).get('/api/auth/me').set(authHeader(token));
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('SESSION_NOT_FOUND');
  });

  it('rejects revoked session', async () => {
    const token = await loginSuperAdmin();
    await Session.updateMany({}, { $set: { revokedAt: new Date() } });
    const response = await request(app).get('/api/auth/me').set(authHeader(token));
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('SESSION_REVOKED');
  });

  it('rejects expired session', async () => {
    const token = await loginSuperAdmin();
    await Session.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const response = await request(app).get('/api/auth/me').set(authHeader(token));
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('SESSION_EXPIRED');
  });

  it('rejects inactive user', async () => {
    const token = await loginSuperAdmin();
    const { User } = await import('./helpers.js');
    await User.updateOne(
      { email: 'middleware@example.com' },
      { $set: { accountStatus: 'INACTIVE' } }
    );

    const response = await request(app).get('/api/auth/me').set(authHeader(token));
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('ACCOUNT_INACTIVE');
  });

  it('rejects regular user with invalid organization context', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const user = await createUser({
      email: 'org-user@example.com',
      organizationMemberships: [{ organizationId: orgId, status: 'ACTIVE' }],
    });

    const login = await loginRequest({
      email: 'org-user@example.com',
      password: TEST_PASSWORD,
    });
    expect(login.status).toBe(200);

    const session = await Session.findOne({ userId: user._id });
    // Tamper session organization to a different org
    session.organizationId = new mongoose.Types.ObjectId();
    await session.save();

    const forged = jwt.sign(
      {
        userId: String(user._id),
        sessionId: String(session._id),
        organizationId: String(session.organizationId),
        platformRole: null,
      },
      env.JWT_ACCESS_SECRET,
      { expiresIn: '15m' }
    );

    const response = await request(app).get('/api/auth/me').set(authHeader(forged));
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('INVALID_ORGANIZATION_CONTEXT');
  });
});
