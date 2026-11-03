import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  TEST_PASSWORD,
  app,
  connectTestDatabase,
  createSuperAdmin,
  disconnectTestDatabase,
  extractRefreshCookie,
  loginRequest,
  request,
  resetTestDatabase,
  Session,
} from './helpers.js';

describe('Auth logout', () => {
  beforeAll(async () => {
    await connectTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await disconnectTestDatabase();
  });

  const login = async (email = 'logout@example.com') => {
    await createSuperAdmin({ email });
    const response = await loginRequest({ email, password: TEST_PASSWORD });
    return {
      accessToken: response.body.data.accessToken,
      cookie: extractRefreshCookie(response),
    };
  };

  it('revokes the current session and clears the refresh cookie', async () => {
    const { accessToken, cookie } = await login();

    const response = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Cookie', cookie.split(';')[0]);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);

    const setCookie = extractRefreshCookie(response) || '';
    expect(setCookie.toLowerCase()).toMatch(/refreshToken=;/i);

    const sessions = await Session.find({});
    expect(sessions).toHaveLength(1);
    expect(sessions[0].revokedAt).toBeTruthy();
  });

  it('prevents refresh after logout', async () => {
    const { accessToken, cookie } = await login('logout-refresh@example.com');
    const cookieHeader = cookie.split(';')[0];

    await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Cookie', cookieHeader);

    const refresh = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookieHeader);

    expect(refresh.status).toBe(401);
  });

  it('logout-all revokes every active session for the user', async () => {
    await createSuperAdmin({ email: 'logout-all@example.com' });

    const first = await loginRequest({
      email: 'logout-all@example.com',
      password: TEST_PASSWORD,
    });
    const second = await loginRequest({
      email: 'logout-all@example.com',
      password: TEST_PASSWORD,
    });

    expect(await Session.countDocuments({ revokedAt: null })).toBe(2);

    const response = await request(app)
      .post('/api/auth/logout-all')
      .set('Authorization', `Bearer ${first.body.data.accessToken}`)
      .set('Cookie', extractRefreshCookie(first).split(';')[0]);

    expect(response.status).toBe(200);
    expect(response.body.data.revokedCount).toBe(2);
    expect(await Session.countDocuments({ revokedAt: null })).toBe(0);

    const refreshSecond = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', extractRefreshCookie(second).split(';')[0]);
    expect(refreshSecond.status).toBe(401);
  });
});
