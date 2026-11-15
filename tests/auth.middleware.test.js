import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import Organization from '../src/models/Organization.js';
import Department from '../src/models/Department.js';
import Role from '../src/models/Role.js';
import UserRoleAssignment from '../src/models/UserRoleAssignment.js';
import {
  DEPARTMENT_MANAGER_PERMISSIONS,
  DEPARTMENT_MEMBER_PERMISSIONS,
  DEPARTMENT_MEMBER_ROLE_NAME,
  ORGANIZATION_ADMIN_PERMISSIONS,
  ORGANIZATION_ADMIN_ROLE_NAME,
} from '../src/config/constants.js';

const authHeader = (token) => ({ Authorization: `Bearer ${token}` });

const createOrganizationContext = async (suffix) => {
  const platformAdmin = await createSuperAdmin({ email: `me-platform-${suffix}@example.com` });
  const organizationId = new mongoose.Types.ObjectId();
  await Organization.create({
    _id: organizationId,
    name: `Me Organization ${suffix}`,
    status: 'ACTIVE',
    createdBy: platformAdmin._id,
  });
  return { platformAdmin, organizationId };
};

const createRole = ({ organizationId, createdBy, name, permissions, roleType, status = 'ACTIVE' }) =>
  Role.create({
    organizationId,
    name,
    roleType,
    permissions,
    status,
    createdBy,
  });

const createAssignment = ({
  userId,
  roleId,
  organizationId,
  assignedBy,
  scopeType = 'ORGANIZATION',
  departmentId = null,
  status = 'ACTIVE',
}) =>
  UserRoleAssignment.create({
    userId,
    roleId,
    organizationId,
    assignedBy,
    scopeType,
    departmentId,
    status,
  });

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
    expect(response.body.data.user.authorization).toEqual({
      platformPermissions: [],
      organizationPermissions: [],
      departmentPermissions: {},
    });
  });

  it('returns organization-wide permissions for an Organization Admin', async () => {
    const { platformAdmin, organizationId } = await createOrganizationContext('admin');
    const user = await createUser({
      email: 'me-org-admin@example.com',
      organizationMemberships: [{ organizationId, status: 'ACTIVE' }],
    });
    const role = await createRole({
      organizationId,
      createdBy: platformAdmin._id,
      name: ORGANIZATION_ADMIN_ROLE_NAME,
      roleType: 'ORGANIZATION_ADMIN',
      permissions: ORGANIZATION_ADMIN_PERMISSIONS,
    });
    await createAssignment({
      userId: user._id,
      roleId: role._id,
      organizationId,
      assignedBy: platformAdmin._id,
    });

    const login = await loginRequest({ email: user.email, password: TEST_PASSWORD });
    const response = await request(app)
      .get('/api/auth/me')
      .set(authHeader(login.body.data.accessToken));

    expect(response.status).toBe(200);
    expect(response.body.data.user).toMatchObject({
      id: String(user._id),
      platformRole: null,
      organizationId: String(organizationId),
    });
    expect(response.body.data.user.authorization).toEqual({
      platformPermissions: [],
      organizationPermissions: [...ORGANIZATION_ADMIN_PERMISSIONS].sort(),
      departmentPermissions: {},
    });
  });

  it('returns the union of active assignments without widening their department scopes', async () => {
    const { platformAdmin, organizationId } = await createOrganizationContext('scoped');
    const finance = await Department.create({
      organizationId,
      name: 'Finance',
      status: 'ACTIVE',
    });
    const hr = await Department.create({
      organizationId,
      name: 'Human Resources',
      status: 'ACTIVE',
    });
    const inactiveDepartment = await Department.create({
      organizationId,
      name: 'Inactive Department',
      status: 'INACTIVE',
    });
    const user = await createUser({
      email: 'me-scoped-user@example.com',
      organizationMemberships: [{ organizationId, status: 'ACTIVE' }],
    });
    const roles = await Promise.all([
      createRole({
        organizationId,
        createdBy: platformAdmin._id,
        name: 'Organization Request Viewer',
        roleType: 'CUSTOM',
        permissions: ['requests.view'],
      }),
      createRole({
        organizationId,
        createdBy: platformAdmin._id,
        name: 'Department Manager',
        roleType: 'DEPARTMENT_MANAGER',
        permissions: DEPARTMENT_MANAGER_PERMISSIONS,
      }),
      createRole({
        organizationId,
        createdBy: platformAdmin._id,
        name: 'Inactive Assignment Role',
        roleType: 'CUSTOM',
        permissions: ['audit_logs.view'],
      }),
      createRole({
        organizationId,
        createdBy: platformAdmin._id,
        name: 'Inactive Role',
        roleType: 'CUSTOM',
        permissions: ['workflows.manage'],
        status: 'INACTIVE',
      }),
      createRole({
        organizationId,
        createdBy: platformAdmin._id,
        name: 'Inactive Department Role',
        roleType: 'CUSTOM',
        permissions: ['roles.view'],
      }),
    ]);

    await Promise.all([
      createAssignment({
        userId: user._id,
        roleId: roles[0]._id,
        organizationId,
        assignedBy: platformAdmin._id,
      }),
      createAssignment({
        userId: user._id,
        roleId: roles[1]._id,
        organizationId,
        assignedBy: platformAdmin._id,
        scopeType: 'DEPARTMENT',
        departmentId: finance._id,
      }),
      createAssignment({
        userId: user._id,
        roleId: roles[1]._id,
        organizationId,
        assignedBy: platformAdmin._id,
        scopeType: 'DEPARTMENT',
        departmentId: hr._id,
      }),
      createAssignment({
        userId: user._id,
        roleId: roles[2]._id,
        organizationId,
        assignedBy: platformAdmin._id,
        status: 'INACTIVE',
      }),
      createAssignment({
        userId: user._id,
        roleId: roles[3]._id,
        organizationId,
        assignedBy: platformAdmin._id,
      }),
      createAssignment({
        userId: user._id,
        roleId: roles[4]._id,
        organizationId,
        assignedBy: platformAdmin._id,
        scopeType: 'DEPARTMENT',
        departmentId: inactiveDepartment._id,
      }),
    ]);

    const login = await loginRequest({ email: user.email, password: TEST_PASSWORD });
    const response = await request(app)
      .get('/api/auth/me')
      .query({ userId: String(platformAdmin._id) })
      .set(authHeader(login.body.data.accessToken));

    expect(response.status).toBe(200);
    expect(response.body.data.user.id).toBe(String(user._id));
    expect(response.body.data.user.authorization).toEqual({
      platformPermissions: [],
      organizationPermissions: ['requests.view'],
      departmentPermissions: {
        [String(finance._id)]: [...DEPARTMENT_MANAGER_PERMISSIONS].sort(),
        [String(hr._id)]: [...DEPARTMENT_MANAGER_PERMISSIONS].sort(),
      },
    });
  });

  it('returns department-only permissions for an Employee role', async () => {
    const { platformAdmin, organizationId } = await createOrganizationContext('employee');
    const department = await Department.create({
      organizationId,
      name: 'Operations',
      status: 'ACTIVE',
    });
    const user = await createUser({
      email: 'me-employee@example.com',
      organizationMemberships: [
        { organizationId, departmentId: department._id, status: 'ACTIVE' },
      ],
    });
    const role = await createRole({
      organizationId,
      createdBy: platformAdmin._id,
      name: DEPARTMENT_MEMBER_ROLE_NAME,
      roleType: 'EMPLOYEE',
      permissions: DEPARTMENT_MEMBER_PERMISSIONS,
    });
    await createAssignment({
      userId: user._id,
      roleId: role._id,
      organizationId,
      assignedBy: platformAdmin._id,
      scopeType: 'DEPARTMENT',
      departmentId: department._id,
    });

    const login = await loginRequest({ email: user.email, password: TEST_PASSWORD });
    const response = await request(app)
      .get('/api/auth/me')
      .set(authHeader(login.body.data.accessToken));

    expect(response.status).toBe(200);
    expect(response.body.data.user.authorization).toEqual({
      platformPermissions: [],
      organizationPermissions: [],
      departmentPermissions: {
        [String(department._id)]: [...DEPARTMENT_MEMBER_PERMISSIONS].sort(),
      },
    });
  });

  it('fails the profile request when permission resolution fails', async () => {
    const { organizationId } = await createOrganizationContext('resolver-error');
    const user = await createUser({
      email: 'me-resolver-error@example.com',
      organizationMemberships: [{ organizationId, status: 'ACTIVE' }],
    });
    const login = await loginRequest({ email: user.email, password: TEST_PASSWORD });
    const assignmentFindSpy = vi.spyOn(UserRoleAssignment, 'find').mockImplementation(() => {
      throw new Error('Permission lookup failed.');
    });

    try {
      const response = await request(app)
        .get('/api/auth/me')
        .set(authHeader(login.body.data.accessToken));
      expect(response.status).toBe(500);
      expect(response.body.code).toBe('INTERNAL_ERROR');
      expect(response.body.data).toBeUndefined();
    } finally {
      assignmentFindSpy.mockRestore();
    }
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
    await Organization.create({
      _id: orgId,
      name: 'Middleware Organization',
      createdBy: user._id,
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
