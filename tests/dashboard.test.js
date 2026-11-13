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
import Organization from '../src/models/Organization.js';
import Department from '../src/models/Department.js';
import Role from '../src/models/Role.js';
import UserRoleAssignment from '../src/models/UserRoleAssignment.js';
import { validateDateRange } from '../src/modules/dashboard/dashboard.validation.js';

const authHeader = (token) => ({ Authorization: `Bearer ${token}` });
let emailSequence = 0;

const createDashboardUser = async ({ roles, scopeType = 'ORGANIZATION', status = 'ACTIVE' }) => {
  const organizationId = new mongoose.Types.ObjectId();
  const user = await createUser({
    name: 'Dashboard User',
    email: `dashboard-${++emailSequence}@example.com`,
    organizationMemberships: [{ organizationId, departmentId: null, status: 'ACTIVE' }],
  });
  await Organization.create({
    _id: organizationId,
    name: `Dashboard Organization ${emailSequence}`,
    status: 'ACTIVE',
    createdBy: user._id,
  });
  const department = scopeType === 'DEPARTMENT'
    ? await Department.create({
      organizationId,
      name: `Dashboard Department ${emailSequence}`,
      status: 'ACTIVE',
    })
    : null;
  if (department) {
    user.organizationMemberships[0].departmentId = department._id;
    await user.save();
  }

  for (const [index, roleConfig] of roles.entries()) {
    const role = await Role.create({
      organizationId,
      name: `Custom Dashboard Role ${emailSequence}-${index}`,
      roleType: roleConfig.roleType || 'CUSTOM',
      permissions: roleConfig.permissions,
      status: roleConfig.roleStatus || 'ACTIVE',
      createdBy: user._id,
    });
    await UserRoleAssignment.create({
      userId: user._id,
      roleId: role._id,
      organizationId,
      departmentId: scopeType === 'DEPARTMENT' ? department._id : null,
      scopeType,
      status: roleConfig.assignmentStatus || status,
      assignedBy: user._id,
    });
  }

  const login = await loginRequest({ email: user.email, password: TEST_PASSWORD });
  expect(login.status).toBe(200);
  return {
    token: login.body.data.accessToken,
    organizationId,
    department,
  };
};

describe('Dashboard configuration API', () => {
  beforeAll(async () => {
    await connectTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await disconnectTestDatabase();
  });

  it('requires authentication', async () => {
    const response = await request(app).get('/api/dashboard/config');
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHORIZED');
  });

  it('rejects users without effective dashboard.view permission', async () => {
    const { token } = await createDashboardUser({
      roles: [{ permissions: ['requests.view'] }],
    });

    const response = await request(app).get('/api/dashboard/config').set(authHeader(token));
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('DASHBOARD_ACCESS_DENIED');
  });

  it('returns an empty widget list when the user has dashboard access but no eligible widgets', async () => {
    const { token } = await createDashboardUser({
      roles: [{ permissions: ['dashboard.view'] }],
    });

    const response = await request(app).get('/api/dashboard/config').set(authHeader(token));
    expect(response.status).toBe(200);
    expect(response.body.data.dashboardType).toBe('DYNAMIC');
    expect(response.body.data.widgets).toEqual([]);
  });

  it('resolves widgets from multiple custom roles without relying on role names', async () => {
    const { token } = await createDashboardUser({
      roles: [
        { permissions: ['dashboard.view', 'requests.view', 'requests.approve', 'users.view'] },
        { permissions: ['requests.view', 'requests.create', 'departments.view', 'audit_logs.view'] },
      ],
    });

    const response = await request(app).get('/api/dashboard/config').set(authHeader(token));
    expect(response.status).toBe(200);
    expect(response.body.data.widgets.map(({ key }) => key)).toEqual([
      'REQUEST_SUMMARY',
      'REQUEST_CREATE',
      'APPROVAL_SUMMARY',
      'APPROVAL_ACTIVITY',
      'USER_STATISTICS',
      'DEPARTMENT_OVERVIEW',
      'AUDIT_ACTIVITY',
    ]);
  });

  it('reports department scope for department-scoped permissions', async () => {
    const { token } = await createDashboardUser({
      scopeType: 'DEPARTMENT',
      roles: [{ permissions: ['dashboard.view', 'requests.view', 'requests.create', 'requests.approve'] }],
    });

    const response = await request(app).get('/api/dashboard/config').set(authHeader(token));
    expect(response.status).toBe(200);
    expect(response.body.data.widgets).toEqual([
      expect.objectContaining({ key: 'REQUEST_SUMMARY', scope: 'DEPARTMENT' }),
      expect.objectContaining({ key: 'REQUEST_CREATE', scope: 'DEPARTMENT' }),
      expect.objectContaining({ key: 'APPROVAL_SUMMARY', scope: 'AUTHORIZED_APPROVAL_ASSIGNMENTS' }),
      expect.objectContaining({ key: 'APPROVAL_ACTIVITY', scope: 'AUTHORIZED_APPROVAL_ASSIGNMENTS' }),
    ]);
  });

  it('keeps role overview unavailable to custom roles with roles.view alone', async () => {
    const { token } = await createDashboardUser({
      scopeType: 'DEPARTMENT',
      roles: [{
        permissions: [
          'dashboard.view',
          'users.view',
          'departments.view',
          'roles.view',
        ],
      }],
    });

    const response = await request(app).get('/api/dashboard/config').set(authHeader(token));
    expect(response.status).toBe(200);
    expect(response.body.data.widgets).toEqual([
      expect.objectContaining({ key: 'USER_STATISTICS', scope: 'DEPARTMENT', analyticsProvider: 'USERS' }),
      expect.objectContaining({ key: 'DEPARTMENT_OVERVIEW', scope: 'DEPARTMENT', analyticsProvider: 'DEPARTMENTS' }),
    ]);
  });

  it('exposes role overview only through existing organization-admin role authorization', async () => {
    const { token } = await createDashboardUser({
      roles: [{
        roleType: 'ORGANIZATION_ADMIN',
        permissions: ['dashboard.view', 'roles.view'],
      }],
    });

    const response = await request(app).get('/api/dashboard/config').set(authHeader(token));
    expect(response.status).toBe(200);
    expect(response.body.data.widgets).toEqual([
      expect.objectContaining({ key: 'ROLE_OVERVIEW', scope: 'ORGANIZATION', kpiProvider: 'ROLES' }),
    ]);
  });

  it('does not use inactive assignments or roles to grant dashboard access', async () => {
    const { token } = await createDashboardUser({
      roles: [
        { permissions: ['dashboard.view'], assignmentStatus: 'INACTIVE' },
        { permissions: ['dashboard.view'], roleStatus: 'INACTIVE' },
      ],
    });

    const response = await request(app).get('/api/dashboard/config').set(authHeader(token));
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('DASHBOARD_ACCESS_DENIED');
  });

  it('keeps platform Super Admin configuration separate from tenant widgets', async () => {
    await createSuperAdmin({ email: 'dashboard-platform-admin@example.com' });
    const login = await loginRequest({
      email: 'dashboard-platform-admin@example.com',
      password: TEST_PASSWORD,
    });
    const response = await request(app)
      .get('/api/dashboard/config')
      .set(authHeader(login.body.data.accessToken));

    expect(response.status).toBe(200);
    expect(response.body.data.dashboardType).toBe('PLATFORM');
    expect(response.body.data.userContext.organizationId).toBeNull();
    expect(response.body.data.widgets.map(({ key, scope }) => ({ key, scope }))).toEqual([
      { key: 'PLATFORM_OVERVIEW', scope: 'PLATFORM' },
      { key: 'ORGANIZATION_ANALYTICS', scope: 'PLATFORM' },
      { key: 'USER_ANALYTICS', scope: 'PLATFORM' },
      { key: 'PLATFORM_USAGE_ANALYTICS', scope: 'PLATFORM' },
      { key: 'DEPARTMENT_ANALYTICS', scope: 'PLATFORM' },
      { key: 'PLATFORM_ACTIVITY', scope: 'PLATFORM' },
    ]);
    expect(response.body.data.widgets.some(({ key }) => key.startsWith('APPROVAL'))).toBe(false);
  });

  it('rejects unsupported query parameters instead of permitting caller-selected scope', async () => {
    const { token } = await createDashboardUser({
      roles: [{ permissions: ['dashboard.view'] }],
    });
    const response = await request(app)
      .get('/api/dashboard/config?organizationId=another-organization')
      .set(authHeader(token));

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('Dashboard date range validation', () => {
  const now = new Date('2025-03-15T12:30:00.000Z');

  it.each([
    ['LAST_7_DAYS', '2025-03-08T12:30:00.000Z'],
    ['LAST_30_DAYS', '2025-02-13T12:30:00.000Z'],
    ['LAST_90_DAYS', '2024-12-15T12:30:00.000Z'],
    ['THIS_MONTH', '2025-03-01T00:00:00.000Z'],
    ['THIS_YEAR', '2025-01-01T00:00:00.000Z'],
  ])('normalizes %s using UTC boundaries', (range, expectedFrom) => {
    const result = validateDateRange({ range }, now);
    expect(result.fromDate.toISOString()).toBe(expectedFrom);
    expect(result.toDate).toEqual(now);
    expect(result.timeZone).toBe('UTC');
    expect(result.interval).toBe('[fromDate, toDate)');
  });

  it('normalizes custom date-only ranges to a UTC half-open interval', () => {
    const result = validateDateRange({
      range: 'CUSTOM',
      fromDate: '2025-03-01',
      toDate: '2025-03-03',
    }, now);
    expect(result.fromDate.toISOString()).toBe('2025-03-01T00:00:00.000Z');
    expect(result.toDate.toISOString()).toBe('2025-03-04T00:00:00.000Z');
  });

  it('clips a custom range ending today to the current time', () => {
    const result = validateDateRange({
      range: 'CUSTOM',
      fromDate: '2025-03-15',
      toDate: '2025-03-15',
    }, now);
    expect(result.toDate).toEqual(now);
  });

  it('accepts custom UTC datetimes without changing their boundaries', () => {
    const result = validateDateRange({
      range: 'CUSTOM',
      fromDate: '2025-03-01T09:30:00Z',
      toDate: '2025-03-02T09:30:00Z',
    }, now);
    expect(result.fromDate.toISOString()).toBe('2025-03-01T09:30:00.000Z');
    expect(result.toDate.toISOString()).toBe('2025-03-02T09:30:00.000Z');
  });

  it.each([
    [{ range: 'INVALID' }],
    [{ range: 'CUSTOM', fromDate: '2025-02-30', toDate: '2025-03-02' }],
    [{ range: 'CUSTOM', fromDate: '2025-03-03', toDate: '2025-03-02' }],
    [{ range: 'CUSTOM', fromDate: '2024-01-01', toDate: '2025-03-01' }],
    [{ range: 'CUSTOM', fromDate: '2025-03-01', toDate: '2025-03-16' }],
    [{ range: 'CUSTOM', fromDate: '2025-03-01' }],
    [{ range: 'LAST_7_DAYS', fromDate: '2025-03-01' }],
    [{ range: 'CUSTOM', fromDate: '2025-03-01T25:00:00Z', toDate: '2025-03-02T00:00:00Z' }],
  ])('rejects invalid date range input %j', (input) => {
    expect(() => validateDateRange(input, now)).toThrow();
  });
});
