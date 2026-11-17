import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
} from './helpers.js';
import AuditLog from '../src/models/AuditLog.js';
import Organization from '../src/models/Organization.js';

const authHeader = (token) => ({ Authorization: `Bearer ${token}` });

describe('Super Admin audit logs', () => {
  beforeAll(async () => {
    await connectTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await disconnectTestDatabase();
  });

  it('includes organization administration events written by platform management routes', async () => {
    const superAdmin = await createSuperAdmin({ email: 'platform-org-events@example.com' });
    const login = await loginRequest({ email: superAdmin.email, password: TEST_PASSWORD });
    const token = login.body.data.accessToken;
    const created = await request(app)
      .post('/api/organizations')
      .set(authHeader(token))
      .send({
        name: 'Platform Created Organization',
        admin: {
          name: 'First Organization Admin',
          email: 'first-admin@example.com',
          password: TEST_PASSWORD,
        },
      });

    expect(created.status).toBe(201);
    const organizationId = created.body.data.organization.id;
    await request(app)
      .patch(`/api/organizations/${organizationId}`)
      .set(authHeader(token))
      .send({ name: 'Renamed Platform Organization' })
      .expect(200);
    await request(app)
      .patch(`/api/organizations/${organizationId}/deactivate`)
      .set(authHeader(token))
      .expect(200);
    await request(app)
      .patch(`/api/organizations/${organizationId}/activate`)
      .set(authHeader(token))
      .expect(200);

    const response = await request(app)
      .get('/api/audit-logs/platform?limit=100')
      .set(authHeader(token));

    expect(response.status).toBe(200);
    expect(response.body.data.items.map((item) => item.action)).toEqual(expect.arrayContaining([
      'ORGANIZATION_CREATED',
      'ORGANIZATION_ADMIN_CREATED',
      'ORGANIZATION_UPDATED',
      'ORGANIZATION_DEACTIVATED',
      'ORGANIZATION_ACTIVATED',
    ]));
    expect(response.body.data.pagination.total).toBe(5);
    expect(response.body.data.items.every((item) => item.actorPlatformRole === 'SUPER_ADMIN')).toBe(
      true
    );
  });

  it('returns only platform administration events with newest-first pagination', async () => {
    const superAdmin = await createSuperAdmin({ email: 'platform-audit@example.com' });
    const organization = await Organization.create({
      name: 'Platform Audit Organization',
      createdBy: superAdmin._id,
    });
    const organizationUser = await createUser({
      email: 'tenant-audit@example.com',
      organizationMemberships: [{ organizationId: organization._id, status: 'ACTIVE' }],
    });
    const [superAdminLogin, organizationLogin] = await Promise.all([
      loginRequest({ email: superAdmin.email, password: TEST_PASSWORD }),
      loginRequest({ email: organizationUser.email, password: TEST_PASSWORD }),
    ]);
    const older = new Date('2026-11-16T10:00:00.000Z');
    const adminCreated = new Date('2026-11-16T10:30:00.000Z');
    const deactivated = new Date('2026-11-16T10:45:00.000Z');
    const reactivated = new Date('2026-11-16T10:50:00.000Z');
    const newer = new Date('2026-11-16T11:00:00.000Z');
    await AuditLog.create([
      {
        organizationId: organization._id,
        actorId: superAdmin._id,
        action: 'ORGANIZATION_CREATED',
        resourceType: 'Organization',
        resourceId: organization._id,
        changes: { name: organization.name },
        timestamp: older,
      },
      {
        organizationId: organization._id,
        actorId: superAdmin._id,
        action: 'ORGANIZATION_ADMIN_CREATED',
        resourceType: 'User',
        resourceId: organizationUser._id,
        changes: { name: organizationUser.name, email: organizationUser.email },
        timestamp: adminCreated,
      },
      {
        organizationId: organization._id,
        actorId: superAdmin._id,
        action: 'ORGANIZATION_DEACTIVATED',
        resourceType: 'Organization',
        resourceId: organization._id,
        changes: { status: { from: 'ACTIVE', to: 'INACTIVE' } },
        timestamp: deactivated,
      },
      {
        organizationId: organization._id,
        actorId: superAdmin._id,
        action: 'ORGANIZATION_ACTIVATED',
        resourceType: 'Organization',
        resourceId: organization._id,
        changes: { status: { from: 'INACTIVE', to: 'ACTIVE' } },
        timestamp: reactivated,
      },
      {
        organizationId: organization._id,
        actorId: superAdmin._id,
        action: 'ORGANIZATION_UPDATED',
        resourceType: 'Organization',
        resourceId: organization._id,
        changes: { name: { from: 'Old name', to: 'New name' } },
        timestamp: newer,
      },
      {
        organizationId: organization._id,
        actorId: superAdmin._id,
        action: 'DEPARTMENT_CREATED',
        resourceType: 'Department',
        resourceId: new mongoose.Types.ObjectId(),
        timestamp: new Date('2026-11-16T12:00:00.000Z'),
      },
      {
        organizationId: organization._id,
        actorId: superAdmin._id,
        action: 'USER_CREATED',
        resourceType: 'User',
        resourceId: new mongoose.Types.ObjectId(),
        timestamp: new Date('2026-11-16T12:15:00.000Z'),
      },
      {
        organizationId: organization._id,
        actorId: superAdmin._id,
        action: 'REQUEST_SUBMITTED',
        resourceType: 'Request',
        resourceId: new mongoose.Types.ObjectId(),
        timestamp: new Date('2026-11-16T12:30:00.000Z'),
      },
      {
        organizationId: organization._id,
        actorId: superAdmin._id,
        action: 'WORKFLOW_UPDATED',
        resourceType: 'Workflow',
        resourceId: new mongoose.Types.ObjectId(),
        timestamp: new Date('2026-11-16T12:45:00.000Z'),
      },
      {
        organizationId: organization._id,
        actorId: superAdmin._id,
        action: 'ROLE_PERMISSIONS_UPDATED',
        resourceType: 'Role',
        resourceId: new mongoose.Types.ObjectId(),
        timestamp: new Date('2026-11-16T13:00:00.000Z'),
      },
      {
        organizationId: organization._id,
        actorId: organizationUser._id,
        action: 'USER_UPDATED',
        resourceType: 'User',
        resourceId: organizationUser._id,
        timestamp: new Date('2026-11-16T12:00:00.000Z'),
      },
    ]);

    const pageOne = await request(app)
      .get('/api/audit-logs/platform?page=1&limit=2')
      .set(authHeader(superAdminLogin.body.data.accessToken));

    expect(pageOne.status).toBe(200);
    expect(pageOne.body.data.pagination).toEqual({ page: 1, limit: 2, total: 5, totalPages: 3 });
    expect(pageOne.body.data.items[0]).toMatchObject({
      action: 'ORGANIZATION_UPDATED',
      actorId: String(superAdmin._id),
      actorPlatformRole: 'SUPER_ADMIN',
      actor: { email: superAdmin.email },
      description: 'ORGANIZATION UPDATED — New name',
    });
    expect(pageOne.body.data.items[1].action).toBe('ORGANIZATION_ACTIVATED');

    const pageTwo = await request(app)
      .get('/api/audit-logs/platform?page=2&limit=2')
      .set(authHeader(superAdminLogin.body.data.accessToken));
    expect(pageTwo.status).toBe(200);
    expect(pageTwo.body.data.items.map((item) => item.action)).toEqual([
      'ORGANIZATION_DEACTIVATED',
      'ORGANIZATION_ADMIN_CREATED',
    ]);
    const pageThree = await request(app)
      .get('/api/audit-logs/platform?page=3&limit=2')
      .set(authHeader(superAdminLogin.body.data.accessToken));
    expect(pageThree.status).toBe(200);
    expect(pageThree.body.data.items[0].action).toBe('ORGANIZATION_CREATED');
  });

  it('rejects unauthenticated and non-Super Admin requests', async () => {
    const superAdmin = await createSuperAdmin({ email: 'platform-audit-auth@example.com' });
    const organization = await Organization.create({
      name: 'Platform Audit Auth Organization',
      createdBy: superAdmin._id,
    });
    const organizationUser = await createUser({
      email: 'tenant-audit-auth@example.com',
      organizationMemberships: [{ organizationId: organization._id, status: 'ACTIVE' }],
    });
    const login = await loginRequest({ email: organizationUser.email, password: TEST_PASSWORD });

    const unauthenticated = await request(app)
      .get('/api/audit-logs/platform');
    const forbidden = await request(app)
      .get('/api/audit-logs/platform')
      .set(authHeader(login.body.data.accessToken));

    expect(unauthenticated.status).toBe(401);
    expect(forbidden.status).toBe(403);
  });

  it('includes pre-snapshot logs only when the actor is currently a Super Admin', async () => {
    const superAdmin = await createSuperAdmin({ email: 'legacy-platform-audit@example.com' });
    const organizationUser = await createUser({ email: 'legacy-tenant-audit@example.com' });
    const login = await loginRequest({ email: superAdmin.email, password: TEST_PASSWORD });
    await AuditLog.collection.insertMany([
      {
        _id: new mongoose.Types.ObjectId(),
        actorId: superAdmin._id,
        action: 'ORGANIZATION_CREATED',
        resourceType: 'Organization',
        resourceId: new mongoose.Types.ObjectId(),
        changes: {},
        metadata: {},
        timestamp: new Date(),
      },
      {
        _id: new mongoose.Types.ObjectId(),
        actorId: organizationUser._id,
        action: 'ORGANIZATION_CREATED',
        resourceType: 'Organization',
        resourceId: new mongoose.Types.ObjectId(),
        changes: {},
        metadata: {},
        timestamp: new Date(),
      },
    ]);

    const response = await request(app)
      .get('/api/audit-logs/platform')
      .set(authHeader(login.body.data.accessToken));

    expect(response.status).toBe(200);
    expect(response.body.data.items.map((item) => item.actorId)).toEqual([String(superAdmin._id)]);
  });
});
