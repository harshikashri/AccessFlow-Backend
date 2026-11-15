import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  TEST_PASSWORD,
  app,
  connectTestDatabase,
  createSuperAdmin,
  disconnectTestDatabase,
  loginRequest,
  request,
  resetTestDatabase,
} from './helpers.js';
import AuditLog from '../src/models/AuditLog.js';
import User from '../src/models/User.js';

const authHeader = (token) => ({ Authorization: `Bearer ${token}` });

describe('Phase 11 audit and settings', () => {
  beforeAll(async () => {
    await connectTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await disconnectTestDatabase();
  });

  it('lists, details, and exports authorized audit records without secrets', async () => {
    const superAdmin = await createSuperAdmin({ email: 'phase11-super@example.com' });
    const login = await loginRequest({ email: superAdmin.email, password: TEST_PASSWORD });
    const token = login.body.data.accessToken;
    const resourceId = new mongoose.Types.ObjectId();
    await AuditLog.create({
      actorId: superAdmin._id,
      resourceId,
      action: '=FORMULA',
      resourceType: 'Security',
      changes: { password: 'should-not-persist', name: { from: 'old', to: 'new' } },
    });

    const list = await request(app).get('/api/audit-logs').set(authHeader(token));
    expect(list.status).toBe(200);
    expect(list.body.data.items.some((item) => item.action === '=FORMULA')).toBe(true);
    const event = list.body.data.items.find((item) => item.action === '=FORMULA');
    expect(event.changes.password).toBe('[REDACTED]');

    const detail = await request(app).get(`/api/audit-logs/${event.id}`).set(authHeader(token));
    expect(detail.status).toBe(200);
    expect(detail.body.data.changes.password).toBe('[REDACTED]');

    const exported = await request(app).get('/api/audit-logs/export').set(authHeader(token));
    expect(exported.status).toBe(200);
    expect(exported.text).toContain("'=FORMULA");
  });

  it('persists profile and notification preferences and protects session secrets', async () => {
    const user = await createSuperAdmin({ email: 'phase11-settings@example.com' });
    const login = await loginRequest({ email: user.email, password: TEST_PASSWORD });
    const token = login.body.data.accessToken;

    const profile = await request(app).get('/api/settings/profile').set(authHeader(token));
    expect(profile.status).toBe(200);
    expect(profile.body.data.email).toBe(user.email);

    const update = await request(app)
      .patch('/api/settings/profile')
      .set(authHeader(token))
      .send({ name: 'Updated Settings User' });
    expect(update.status).toBe(200);

    const preferences = await request(app)
      .patch('/api/settings/notifications')
      .set(authHeader(token))
      .send({ email: false, inApp: true });
    expect(preferences.status).toBe(200);
    expect(preferences.body.data.email).toBe(false);

    const sessions = await request(app).get('/api/settings/sessions').set(authHeader(token));
    expect(sessions.status).toBe(200);
    expect(sessions.body.data.items[0].refreshTokenHash).toBeUndefined();
    expect(sessions.body.data.items[0].current).toBe(true);
    expect((await User.findById(user._id)).preferences.notifications.email).toBe(false);
  });
});
