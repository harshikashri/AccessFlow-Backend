import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  TEST_PASSWORD,
  app,
  connectTestDatabase,
  createSuperAdmin,
  disconnectTestDatabase,
  extractRefreshCookie,
  getCookieValue,
  loginRequest,
  request,
  resetTestDatabase,
  Session,
} from './helpers.js';
import { hashToken } from '../src/utils/token.js';

const loginAndGetTokens = async (email = 'admin@example.com') => {
  await createSuperAdmin({ email });
  const response = await loginRequest({ email, password: TEST_PASSWORD });
  const cookie = extractRefreshCookie(response);
  return {
    accessToken: response.body.data.accessToken,
    cookie,
    rawRefresh: getCookieValue(cookie),
  };
};

describe('Auth refresh', () => {
  beforeAll(async () => {
    await connectTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await disconnectTestDatabase();
  });

  it('returns a new access token and rotates the refresh token', async () => {
    const { cookie, rawRefresh } = await loginAndGetTokens();
    const before = await Session.findOne({});
    expect(before.refreshTokenHash).toBe(hashToken(rawRefresh));

    const refreshed = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookie.split(';')[0]);

    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data.accessToken).toBeTruthy();

    const newCookie = extractRefreshCookie(refreshed);
    const newRaw = getCookieValue(newCookie);
    expect(newRaw).toBeTruthy();
    expect(newRaw).not.toBe(rawRefresh);

    const after = await Session.findById(before._id);
    expect(after.refreshTokenHash).toBe(hashToken(newRaw));
    expect(after.refreshTokenHash).not.toBe(before.refreshTokenHash);
  });

  it('rejects the old refresh token after rotation', async () => {
    const { cookie } = await loginAndGetTokens('rotate@example.com');

    const first = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookie.split(';')[0]);
    expect(first.status).toBe(200);

    const second = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookie.split(';')[0]);
    expect(second.status).toBe(401);
    expect(extractRefreshCookie(second)?.toLowerCase() || '').toMatch(/refreshToken=;/i);
  });

  it('rejects invalid refresh tokens', async () => {
    const response = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', 'refreshToken=not-a-real-token');

    expect(response.status).toBe(401);
  });

  it('rejects expired sessions', async () => {
    const { cookie, rawRefresh } = await loginAndGetTokens('expired@example.com');
    await Session.updateOne(
      { refreshTokenHash: hashToken(rawRefresh) },
      { $set: { expiresAt: new Date(Date.now() - 1000) } }
    );

    const response = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookie.split(';')[0]);

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('SESSION_EXPIRED');
  });

  it('rejects revoked sessions', async () => {
    const { cookie, rawRefresh } = await loginAndGetTokens('revoked@example.com');
    await Session.updateOne(
      { refreshTokenHash: hashToken(rawRefresh) },
      { $set: { revokedAt: new Date() } }
    );

    const response = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookie.split(';')[0]);

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('SESSION_REVOKED');
  });

  it('rejects refresh for inactive accounts and revokes the session', async () => {
    const { cookie } = await loginAndGetTokens('later-inactive@example.com');
    const { User } = await import('./helpers.js');
    await User.updateOne(
      { email: 'later-inactive@example.com' },
      { $set: { accountStatus: 'INACTIVE' } }
    );

    const response = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookie.split(';')[0]);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('ACCOUNT_INACTIVE');

    const anySession = await Session.findOne({});
    expect(anySession.revokedAt).toBeTruthy();
  });

  it('allows only one concurrent refresh to succeed for the same token', async () => {
    const { cookie } = await loginAndGetTokens('concurrent@example.com');
    const cookieHeader = cookie.split(';')[0];

    const [first, second] = await Promise.all([
      request(app).post('/api/auth/refresh').set('Cookie', cookieHeader),
      request(app).post('/api/auth/refresh').set('Cookie', cookieHeader),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 401]);

    const activeSessions = await Session.find({ revokedAt: null });
    expect(activeSessions).toHaveLength(1);
  });
});
