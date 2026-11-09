import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendWithResendMock } = vi.hoisted(() => ({ sendWithResendMock: vi.fn() }));
vi.mock('../../src/services/email/resend.provider.js', () => ({ sendWithResend: sendWithResendMock }));

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
  User,
} from '../helpers.js';
import Organization from '../../src/models/Organization.js';
import Department from '../../src/models/Department.js';
import Role from '../../src/models/Role.js';
import UserRoleAssignment from '../../src/models/UserRoleAssignment.js';
import AuditLog from '../../src/models/AuditLog.js';
import {
  DEPARTMENT_MANAGER_PERMISSIONS,
  DEPARTMENT_MANAGER_ROLE_NAME,
  DEPARTMENT_MEMBER_PERMISSIONS,
  DEPARTMENT_MEMBER_ROLE_NAME,
  ORGANIZATION_ADMIN_PERMISSIONS,
  ORGANIZATION_ADMIN_ROLE_NAME,
} from '../../src/config/constants.js';

const authHeader = (token) => ({ Authorization: `Bearer ${token}` });

const createOrganizationContext = async (suffix = 'one') => {
  const platformAdmin = await createSuperAdmin({ email: `platform-${suffix}@example.com` });
  const organizationId = new mongoose.Types.ObjectId();
  const admin = await createUser({
    name: 'Organization Admin',
    email: `org-admin-${suffix}@example.com`,
    organizationMemberships: [{ organizationId, departmentId: null, status: 'ACTIVE' }],
  });
  const organization = await Organization.create({
    _id: organizationId,
    name: `Organization ${suffix}`,
    status: 'ACTIVE',
    createdBy: platformAdmin._id,
  });
  const role = await Role.create({
    organizationId,
    name: ORGANIZATION_ADMIN_ROLE_NAME,
    description: 'Test Organization Admin',
    permissions: ORGANIZATION_ADMIN_PERMISSIONS,
    status: 'ACTIVE',
    createdBy: platformAdmin._id,
  });
  await Role.create([
    {
      organizationId,
      name: DEPARTMENT_MANAGER_ROLE_NAME,
      roleType: 'DEPARTMENT_MANAGER',
      permissions: DEPARTMENT_MANAGER_PERMISSIONS,
      status: 'ACTIVE',
      createdBy: platformAdmin._id,
    },
    {
      organizationId,
      name: DEPARTMENT_MEMBER_ROLE_NAME,
      roleType: 'EMPLOYEE',
      permissions: DEPARTMENT_MEMBER_PERMISSIONS,
      status: 'ACTIVE',
      createdBy: platformAdmin._id,
    },
  ]);
  await UserRoleAssignment.create({
    userId: admin._id,
    roleId: role._id,
    organizationId,
    departmentId: null,
    scopeType: 'ORGANIZATION',
    status: 'ACTIVE',
    assignedBy: platformAdmin._id,
  });
  const login = await loginRequest({ email: admin.email, password: TEST_PASSWORD });
  return { organization, organizationId, admin, token: login.body.data.accessToken, platformAdmin };
};

const createUserViaApi = (token, body) =>
  request(app).post('/api/users').set(authHeader(token)).send(body);

const extractToken = (html, route) => {
  const match = html.match(new RegExp(`${route}\\?token=([^&"<]+)`));
  if (!match) throw new Error(`Could not find token URL for ${route}`);
  return decodeURIComponent(match[1]);
};

const createActiveUser = async ({ organizationId, email, departmentId = null, additionalMemberships = [] }) => {
  const user = await createUser({
    email,
    organizationMemberships: [
      { organizationId, departmentId, status: 'ACTIVE' },
      ...additionalMemberships,
    ],
  });
  return user;
};

describe('User management', () => {
  beforeAll(async () => {
    await connectTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    sendWithResendMock.mockReset();
    sendWithResendMock.mockResolvedValue({ id: 'mock-email-id' });
  });

  afterAll(async () => {
    await disconnectTestDatabase();
  });

  it('creates a pending user, assigns department and roles, and completes first-time password setup', async () => {
    const { organizationId, admin, token } = await createOrganizationContext('create');
    const department = await Department.create({ organizationId, name: 'Engineering' });
    const employeeRole = await Role.create({
      organizationId,
      name: 'Employee',
      permissions: ['users.view'],
      status: 'ACTIVE',
      createdBy: admin._id,
    });

    const response = await createUserViaApi(token, {
      name: '  John Smith ',
      email: ' JOHN.SMITH@example.com ',
      departmentId: String(department._id),
      roleAssignments: [{
        roleId: String(employeeRole._id),
        scopeType: 'DEPARTMENT',
        departmentId: String(department._id),
      }],
    });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      name: 'John Smith',
      email: 'john.smith@example.com',
      accountStatus: 'INACTIVE',
      passwordSetupRequired: true,
    });
    expect(response.body.data.passwordHash).toBeUndefined();
    expect(sendWithResendMock).toHaveBeenCalledOnce();
    expect(sendWithResendMock.mock.calls[0][0].to).toBe('email-test@example.com');
    expect(sendWithResendMock.mock.calls[0][0].html).toContain('john.smith@example.com');

    const createdUser = await User.findById(response.body.data.id);
    expect(createdUser.passwordSetupRequired).toBe(true);
    expect(createdUser.accountStatus).toBe('INACTIVE');
    expect(String(createdUser.organizationMemberships[0].departmentId)).toBe(String(department._id));
    expect(await UserRoleAssignment.countDocuments({ userId: createdUser._id, roleId: employeeRole._id })).toBe(1);

    const raw = await User.collection.findOne({ _id: createdUser._id });
    const setupToken = extractToken(sendWithResendMock.mock.calls[0][0].html, 'set-password');
    expect(raw.passwordSetupTokenHash).toBeTruthy();
    expect(raw.passwordSetupTokenHash).not.toBe(setupToken);

    const blockedLogin = await loginRequest({ email: createdUser.email, password: TEST_PASSWORD });
    expect(blockedLogin.status).toBe(401);

    const setup = await request(app).post('/api/auth/set-password').send({
      token: setupToken,
      password: TEST_PASSWORD,
      confirmPassword: TEST_PASSWORD,
    });

    expect(setup.status).toBe(200);
    expect((await User.findById(createdUser._id)).passwordSetupRequired).toBe(false);
    expect((await User.collection.findOne({ _id: createdUser._id })).passwordSetupTokenHash).toBeUndefined();

    const login = await loginRequest({ email: createdUser.email, password: TEST_PASSWORD });
    expect(login.status).toBe(200);
  });

  it('rejects duplicate role assignments and rolls back user creation when assignment validation fails', async () => {
    const { organizationId, token } = await createOrganizationContext('assignment-rollback');
    const role = await Role.create({
      organizationId,
      name: 'Rollback Role',
      permissions: ['users.view'],
      status: 'ACTIVE',
      createdBy: new mongoose.Types.ObjectId(),
    });

    const duplicate = await createUserViaApi(token, {
      name: 'Duplicate Assignment',
      email: 'duplicate-assignment@example.com',
      roleAssignments: [
        { roleId: String(role._id), scopeType: 'ORGANIZATION' },
        { roleId: String(role._id), scopeType: 'ORGANIZATION' },
      ],
    });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.code).toBe('VALIDATION_ERROR');
    expect(await User.exists({ email: 'duplicate-assignment@example.com' })).toBeNull();

    await Role.updateOne({ _id: role._id }, { $set: { status: 'INACTIVE' } });
    const invalid = await createUserViaApi(token, {
      name: 'Rolled Back User',
      email: 'rolled-back-user@example.com',
      roleAssignments: [{ roleId: String(role._id), scopeType: 'ORGANIZATION' }],
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('INVALID_ROLE_ASSIGNMENT');
    expect(await User.exists({ email: 'rolled-back-user@example.com' })).toBeNull();
  });

  it('rejects invalid create fields, duplicate email, and cross-organization roles/departments', async () => {
    const local = await createOrganizationContext('validation-local');
    const foreign = await createOrganizationContext('validation-foreign');
    const foreignDepartment = await Department.create({ organizationId: foreign.organizationId, name: 'Foreign' });
    const foreignRole = await Role.create({
      organizationId: foreign.organizationId,
      name: 'Foreign Role',
      permissions: ['users.view'],
      createdBy: foreign.admin._id,
    });

    for (const body of [
      { email: 'missing-name@example.com' },
      { name: 'No Email' },
      { name: 'Bad Email', email: 'not-an-email' },
      { name: 'Unsupported', email: 'unsupported@example.com', password: 'Never accepted' },
    ]) {
      expect((await createUserViaApi(local.token, body)).status).toBe(400);
    }

    const foreignDepartmentResponse = await createUserViaApi(local.token, {
      name: 'Foreign Department User',
      email: 'foreign-dept-user@example.com',
      departmentId: String(foreignDepartment._id),
    });
    expect(foreignDepartmentResponse.status).toBe(400);

    const foreignRoleResponse = await createUserViaApi(local.token, {
      name: 'Foreign Role User',
      email: 'foreign-role-user@example.com',
      roleAssignments: [{ roleId: String(foreignRole._id), scopeType: 'ORGANIZATION' }],
    });
    expect(foreignRoleResponse.status).toBe(400);

    const created = await createUserViaApi(local.token, { name: 'Unique User', email: 'unique@example.com' });
    expect(created.status).toBe(201);
    const duplicate = await createUserViaApi(local.token, { name: 'Duplicate User', email: 'unique@example.com' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('EMAIL_EXISTS');
  });

  it('denies unauthenticated, unauthorized, and inactive-organization user creation', async () => {
    const { organizationId, token, platformAdmin } = await createOrganizationContext('security');
    const noPermissionUser = await createActiveUser({ organizationId, email: 'no-user-permission@example.com' });
    const noPermissionLogin = await loginRequest({ email: noPermissionUser.email, password: TEST_PASSWORD });

    expect((await request(app).post('/api/users').send({ name: 'No Auth', email: 'no-auth@example.com' })).status).toBe(401);
    const denied = await createUserViaApi(noPermissionLogin.body.data.accessToken, {
      name: 'Denied',
      email: 'denied@example.com',
    });
    expect(denied.status).toBe(403);

    await Organization.updateOne({ _id: organizationId }, { $set: { status: 'INACTIVE' } });
    const inactiveOrg = await createUserViaApi(token, { name: 'Blocked', email: 'blocked@example.com' });
    expect(inactiveOrg.status).toBe(403);
    expect(inactiveOrg.body.code).toBe('ORGANIZATION_INACTIVE');
    expect(platformAdmin).toBeTruthy();
  });

  it('prevents assigning a role with permissions beyond the caller effective permissions', async () => {
    const { organizationId, admin, token } = await createOrganizationContext('role-escalation');
    const restrictedRole = await Role.create({
      organizationId,
      name: 'Restricted Creator',
      permissions: ['users.create'],
      status: 'ACTIVE',
      createdBy: admin._id,
    });
    const caller = await createActiveUser({ organizationId, email: 'restricted-creator@example.com' });
    await UserRoleAssignment.create({
      userId: caller._id,
      roleId: restrictedRole._id,
      organizationId,
      departmentId: null,
      scopeType: 'ORGANIZATION',
      status: 'ACTIVE',
      assignedBy: admin._id,
    });
    const callerLogin = await loginRequest({ email: caller.email, password: TEST_PASSWORD });
    const privilegedRole = await Role.create({
      organizationId,
      name: 'Privileged User Admin',
      permissions: ['users.deactivate', 'users.edit'],
      status: 'ACTIVE',
      createdBy: admin._id,
    });

    const response = await createUserViaApi(callerLogin.body.data.accessToken, {
      name: 'Escalated User',
      email: 'escalated-user@example.com',
      roleAssignments: [{ roleId: String(privilegedRole._id), scopeType: 'ORGANIZATION' }],
    });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('ROLE_ASSIGNMENT_FORBIDDEN');
    expect(await User.findOne({ email: 'escalated-user@example.com' })).toBeNull();
    expect(token).toBeTruthy();
  });

  it('applies centralized role compatibility during user creation as well as role assignment', async () => {
    const { organizationId, admin, token } = await createOrganizationContext('user-role-compatibility');
    const employeeRole = await Role.create({
      organizationId,
      name: 'Employee Designation',
      roleType: 'EMPLOYEE',
      permissions: ['users.view'],
      status: 'ACTIVE',
      createdBy: admin._id,
    });
    const managerRole = await Role.create({
      organizationId,
      name: 'Department Manager',
      roleType: 'DEPARTMENT_MANAGER',
      permissions: ['departments.view'],
      status: 'ACTIVE',
      createdBy: admin._id,
    });
    const department = await Department.create({ organizationId, name: 'Compatible Scope' });

    const response = await createUserViaApi(token, {
      name: 'Conflicting User',
      email: 'conflicting-user@example.com',
      roleAssignments: [
        { roleId: String(employeeRole._id), scopeType: 'ORGANIZATION' },
        {
          roleId: String(managerRole._id),
          scopeType: 'DEPARTMENT',
          departmentId: String(department._id),
        },
      ],
    });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('ROLE_COMPATIBILITY_CONFLICT');
    expect(await User.findOne({ email: 'conflicting-user@example.com' })).toBeNull();
  });

  it('returns tenant-safe details and paginated, searchable, filterable users', async () => {
    const local = await createOrganizationContext('read-local');
    const foreign = await createOrganizationContext('read-foreign');
    const localDepartment = await Department.create({ organizationId: local.organizationId, name: 'Research' });
    const foreignUser = await createActiveUser({ organizationId: foreign.organizationId, email: 'foreign@example.com' });
    const created = await createUserViaApi(local.token, {
      name: 'Research User',
      email: 'research-user@example.com',
      departmentId: String(localDepartment._id),
    });
    expect(created.status).toBe(201);
    const targetId = created.body.data.id;

    const details = await request(app).get(`/api/users/${targetId}`).set(authHeader(local.token));
    expect(details.status).toBe(200);
    expect(details.body.data.membership.department).toMatchObject({ id: String(localDepartment._id), name: 'Research' });
    expect(details.body.data.passwordHash).toBeUndefined();
    expect(details.body.data.organizationMemberships).toBeUndefined();

    const foreignDetails = await request(app)
      .get(`/api/users/${foreignUser._id}`)
      .set(authHeader(local.token));
    expect(foreignDetails.status).toBe(404);

    const list = await request(app)
      .get('/api/users?page=1&limit=1&search=RESEARCH&status=INACTIVE&departmentId=' + localDepartment._id + '&sortBy=name&sortOrder=asc')
      .set(authHeader(local.token));
    expect(list.status).toBe(200);
    expect(list.body.data.users).toHaveLength(1);
    expect(list.body.data.pagination.total).toBe(1);
    expect(list.body.data.users[0].id).toBe(targetId);
    expect(String(foreignUser._id)).not.toBe(targetId);

    const invalidQuery = await request(app).get('/api/users?sortBy=passwordHash').set(authHeader(local.token));
    expect(invalidQuery.status).toBe(400);
  });

  it('restricts department-scoped user listing to the caller department', async () => {
    const { organizationId, admin, token } = await createOrganizationContext('scoped-users');
    const departmentA = await Department.create({ organizationId, name: 'Scoped Users A' });
    const departmentB = await Department.create({ organizationId, name: 'Scoped Users B' });
    const userA = await createActiveUser({
      organizationId,
      email: 'scoped-user-a@example.com',
      departmentId: departmentA._id,
    });
    await createActiveUser({
      organizationId,
      email: 'scoped-user-b@example.com',
      departmentId: departmentB._id,
    });
    const scopedRole = await Role.create({
      organizationId,
      name: 'Department User Viewer',
      permissions: ['users.view'],
      status: 'ACTIVE',
      createdBy: admin._id,
    });
    const viewer = await createActiveUser({
      organizationId,
      email: 'scoped-user-viewer@example.com',
      departmentId: departmentA._id,
    });
    await UserRoleAssignment.create({
      userId: viewer._id,
      roleId: scopedRole._id,
      organizationId,
      departmentId: departmentA._id,
      scopeType: 'DEPARTMENT',
      status: 'ACTIVE',
      assignedBy: admin._id,
    });
    const viewerLogin = await loginRequest({ email: viewer.email, password: TEST_PASSWORD });

    const list = await request(app)
      .get('/api/users')
      .set(authHeader(viewerLogin.body.data.accessToken));
    expect(list.status).toBe(200);
    expect(list.body.data.users.map((user) => user.id)).toContain(String(userA._id));
    expect(list.body.data.users.some((user) => user.email === 'scoped-user-b@example.com')).toBe(false);

    const requestedOtherDepartment = await request(app)
      .get(`/api/users?departmentId=${departmentB._id}`)
      .set(authHeader(viewerLogin.body.data.accessToken));
    expect(requestedOtherDepartment.status).toBe(200);
    expect(requestedOtherDepartment.body.data.users).toEqual([]);
    expect(token).toBeTruthy();
  });

  it('updates only allowed profile fields and records before/after audit changes', async () => {
    const { organizationId, token } = await createOrganizationContext('update');
    const target = await createActiveUser({ organizationId, email: 'update-before@example.com' });
    const response = await request(app)
      .patch(`/api/users/${target._id}`)
      .set(authHeader(token))
      .send({ name: 'Updated Name', email: 'UPDATE-AFTER@example.com' });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ name: 'Updated Name', email: 'update-after@example.com' });
    expect(await Session.countDocuments({ userId: target._id, revokedAt: { $ne: null } })).toBe(0);

    const rejected = await request(app)
      .patch(`/api/users/${target._id}`)
      .set(authHeader(token))
      .send({ platformRole: 'SUPER_ADMIN', accountStatus: 'ACTIVE', passwordHash: 'nope' });
    expect(rejected.status).toBe(400);
    const audit = await AuditLog.findOne({ resourceId: target._id, action: 'USER_UPDATED' }).lean();
    expect(audit.changes.name).toEqual({ from: 'Test User', to: 'Updated Name' });
    expect(audit.changes.email).toEqual({ from: 'update-before@example.com', to: 'update-after@example.com' });
  });

  it('assigns or removes the organization membership department without touching other memberships', async () => {
    const { organizationId, token } = await createOrganizationContext('department');
    const otherOrganizationId = new mongoose.Types.ObjectId();
    const department = await Department.create({ organizationId, name: 'Design' });
    const otherDepartmentId = new mongoose.Types.ObjectId();
    const target = await createActiveUser({
      organizationId,
      email: 'department-target@example.com',
      additionalMemberships: [{ organizationId: otherOrganizationId, departmentId: otherDepartmentId, status: 'ACTIVE' }],
    });

    const assign = await request(app)
      .patch(`/api/users/${target._id}/department`)
      .set(authHeader(token))
      .send({ departmentId: String(department._id) });
    expect(assign.status).toBe(200);
    const assigned = await User.findById(target._id);
    expect(String(assigned.organizationMemberships[0].departmentId)).toBe(String(department._id));
    expect(String(assigned.organizationMemberships[1].departmentId)).toBe(String(otherDepartmentId));

    const remove = await request(app)
      .patch(`/api/users/${target._id}/department`)
      .set(authHeader(token))
      .send({ departmentId: null });
    expect(remove.status).toBe(200);
    const removed = await User.findById(target._id);
    expect(removed.organizationMemberships[0].departmentId).toBeNull();
    expect(String(removed.organizationMemberships[1].departmentId)).toBe(String(otherDepartmentId));
    expect(await AuditLog.countDocuments({ resourceId: target._id, action: 'USER_DEPARTMENT_ASSIGNED' })).toBe(1);
    expect(await AuditLog.countDocuments({ resourceId: target._id, action: 'USER_DEPARTMENT_REMOVED' })).toBe(1);
  });

  it('deactivates only one organization membership, revokes its sessions, and protects the last admin', async () => {
    const { organizationId, admin, token } = await createOrganizationContext('status');
    const otherOrganizationId = new mongoose.Types.ObjectId();
    const target = await createActiveUser({
      organizationId,
      email: 'status-target@example.com',
      additionalMemberships: [{ organizationId: otherOrganizationId, departmentId: null, status: 'ACTIVE' }],
    });
    const userLogin = await loginRequest({
      email: target.email,
      password: TEST_PASSWORD,
      organizationId: String(organizationId),
    });
    const session = await Session.findOne({ userId: target._id, organizationId });

    const deactivated = await request(app)
      .patch(`/api/users/${target._id}/deactivate`)
      .set(authHeader(token));
    expect(deactivated.status).toBe(200);
    const saved = await User.findById(target._id);
    expect(saved.accountStatus).toBe('ACTIVE');
    expect(saved.organizationMemberships[0].status).toBe('INACTIVE');
    expect(saved.organizationMemberships[1].status).toBe('ACTIVE');
    expect((await Session.findById(session._id)).revokedAt).toBeTruthy();
    expect(userLogin.status).toBe(200);

    const reactivate = await request(app)
      .patch(`/api/users/${target._id}/activate`)
      .set(authHeader(token));
    expect(reactivate.status).toBe(200);

    const operator = await createActiveUser({
      organizationId,
      email: 'deactivation-operator@example.com',
    });
    const operatorRole = await Role.create({
      organizationId,
      name: 'User Deactivation Operator',
      permissions: ['users.deactivate'],
      status: 'ACTIVE',
      createdBy: admin._id,
    });
    await UserRoleAssignment.create({
      userId: operator._id,
      roleId: operatorRole._id,
      organizationId,
      departmentId: null,
      scopeType: 'ORGANIZATION',
      status: 'ACTIVE',
      assignedBy: admin._id,
    });
    const operatorLogin = await loginRequest({ email: operator.email, password: TEST_PASSWORD });
    const lastAdmin = await request(app)
      .patch(`/api/users/${admin._id}/deactivate`)
      .set(authHeader(operatorLogin.body.data.accessToken));
    expect(lastAdmin.status).toBe(409);
    expect(lastAdmin.body.code).toBe('LAST_ORGANIZATION_ADMIN');

    const selfDeactivate = await request(app)
      .patch(`/api/users/${admin._id}/deactivate`)
      .set(authHeader(token));
    expect(selfDeactivate.status).toBe(403);
    expect(selfDeactivate.body.code).toBe('SELF_DEACTIVATION_FORBIDDEN');
  });

  it('supports forgot, admin-initiated, and reset password flows with single-use tokens', async () => {
    const { organizationId, token } = await createOrganizationContext('password');
    const target = await createActiveUser({ organizationId, email: 'password-target@example.com' });
    const oldLogin = await loginRequest({ email: target.email, password: TEST_PASSWORD });
    expect(oldLogin.status).toBe(200);

    const forgot = await request(app).post('/api/auth/forgot-password').send({ email: target.email });
    expect(forgot.status).toBe(200);
    expect(forgot.body.message).toMatch(/does not confirm email delivery/i);
    const forgotCall = sendWithResendMock.mock.calls.at(-1)[0];
    expect(forgotCall.to).toBe('email-test@example.com');
    const resetToken = extractToken(forgotCall.html, 'reset-password');
    const stored = await User.findById(target._id).select('+passwordResetTokenHash');
    expect(stored.passwordResetTokenHash).not.toBe(resetToken);

    const reset = await request(app).post('/api/auth/reset-password').send({
      token: resetToken,
      password: 'NewStrongPassword123!',
      confirmPassword: 'NewStrongPassword123!',
    });
    expect(reset.status).toBe(200);
    expect((await Session.findOne({ userId: target._id })).revokedAt).toBeTruthy();
    expect((await loginRequest({ email: target.email, password: TEST_PASSWORD })).status).toBe(401);
    expect((await loginRequest({ email: target.email, password: 'NewStrongPassword123!' })).status).toBe(200);

    const invalidToken = await request(app).post('/api/auth/reset-password').send({
      token: 'x'.repeat(43),
      password: 'OtherStrongPassword123!',
      confirmPassword: 'OtherStrongPassword123!',
    });
    expect(invalidToken.status).toBe(400);
    expect(invalidToken.body.code).toBe('INVALID_RESET_TOKEN');

    const usedToken = await request(app).post('/api/auth/reset-password').send({
      token: resetToken,
      password: 'OtherStrongPassword123!',
      confirmPassword: 'OtherStrongPassword123!',
    });
    expect(usedToken.status).toBe(400);
    expect(usedToken.body.code).toBe('INVALID_RESET_TOKEN');

    const adminReset = await request(app)
      .post(`/api/users/${target._id}/password-reset`)
      .set(authHeader(token));
    expect(adminReset.status).toBe(200);
    expect(sendWithResendMock.mock.calls.at(-1)[0].subject).toBe('Reset your AccessFlow password');
  });

  it('sends self-service reset emails for legacy Organization Admin and Super Admin records without setup flags', async () => {
    const { admin } = await createOrganizationContext('legacy-admin');
    await User.updateOne({ _id: admin._id }, { $unset: { passwordSetupRequired: 1 } });
    const superAdmin = await createSuperAdmin({ email: 'legacy-super-admin@example.com' });
    await User.updateOne({ _id: superAdmin._id }, { $unset: { passwordSetupRequired: 1 } });

    for (const email of [admin.email, superAdmin.email]) {
      const response = await request(app)
        .post('/api/auth/forgot-password')
        .send({ email });
      expect(response.status).toBe(200);
      expect(response.body.message).toMatch(/does not confirm email delivery/i);
      expect(sendWithResendMock).toHaveBeenCalled();
      expect(sendWithResendMock.mock.calls.at(-1)[0].to).toBe('email-test@example.com');
      expect(sendWithResendMock.mock.calls.at(-1)[0].subject).toBe('Reset your AccessFlow password');
    }

    const adminRecord = await User.collection.findOne({ _id: admin._id });
    const superAdminRecord = await User.collection.findOne({ _id: superAdmin._id });
    expect(adminRecord.passwordResetTokenHash).toBeTruthy();
    expect(superAdminRecord.passwordResetTokenHash).toBeTruthy();
  });

  it('revokes sessions across every organization after a multi-organization password reset', async () => {
    const first = await createOrganizationContext('multi-reset-one');
    const second = await createOrganizationContext('multi-reset-two');
    const multiOrgUser = await createUser({
      email: 'multi-org-reset@example.com',
      organizationMemberships: [
        { organizationId: first.organizationId, departmentId: null, status: 'ACTIVE' },
        { organizationId: second.organizationId, departmentId: null, status: 'ACTIVE' },
      ],
    });

    const firstLogin = await loginRequest({
      email: multiOrgUser.email,
      password: TEST_PASSWORD,
      organizationId: String(first.organizationId),
    });
    const secondLogin = await loginRequest({
      email: multiOrgUser.email,
      password: TEST_PASSWORD,
      organizationId: String(second.organizationId),
    });
    expect(firstLogin.status).toBe(200);
    expect(secondLogin.status).toBe(200);

    await request(app).post('/api/auth/forgot-password').send({ email: multiOrgUser.email });
    const resetToken = extractToken(sendWithResendMock.mock.calls.at(-1)[0].html, 'reset-password');
    const rawUser = await User.collection.findOne({ _id: multiOrgUser._id });
    await User.collection.updateOne(
      { _id: multiOrgUser._id },
      { $set: { passwordResetTokenExpiresAt: new Date(Date.now() - 1000) } }
    );
    const expired = await request(app).post('/api/auth/reset-password').send({
      token: resetToken,
      password: 'NewStrongPassword123!',
      confirmPassword: 'NewStrongPassword123!',
    });
    expect(expired.status).toBe(400);
    expect(expired.body.code).toBe('INVALID_RESET_TOKEN');
    expect(rawUser.passwordResetTokenHash).toBeTruthy();

    await request(app).post('/api/auth/forgot-password').send({ email: multiOrgUser.email });
    const refreshedResetToken = extractToken(sendWithResendMock.mock.calls.at(-1)[0].html, 'reset-password');
    const reset = await request(app).post('/api/auth/reset-password').send({
      token: refreshedResetToken,
      password: 'NewStrongPassword123!',
      confirmPassword: 'NewStrongPassword123!',
    });
    expect(reset.status).toBe(200);

    const sessions = await Session.find({ userId: multiOrgUser._id }).lean();
    expect(sessions).toHaveLength(2);
    expect(sessions.every((session) => session.revokedAt)).toBe(true);
  });

  it('rejects expired first-time setup tokens', async () => {
    const { organizationId, token } = await createOrganizationContext('expired-setup');
    const created = await createUserViaApi(token, {
      name: 'Expired Setup User',
      email: 'expired-setup@example.com',
    });
    const setupToken = extractToken(sendWithResendMock.mock.calls.at(-1)[0].html, 'set-password');
    await User.updateOne(
      { _id: created.body.data.id },
      { $set: { passwordSetupTokenExpiresAt: new Date(Date.now() - 1000) } }
    );

    const response = await request(app).post('/api/auth/set-password').send({
      token: setupToken,
      password: TEST_PASSWORD,
      confirmPassword: TEST_PASSWORD,
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_SETUP_TOKEN');
    const user = await User.findById(created.body.data.id);
    expect(user.passwordSetupRequired).toBe(true);
    expect(user.accountStatus).toBe('INACTIVE');
    expect(String(user.organizationMemberships[0].organizationId)).toBe(String(organizationId));
  });

  it('returns a generic forgot-password response for unknown addresses and a controlled error on email delivery failure', async () => {
    const context = await createOrganizationContext('email-failure');
    const missing = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'missing-reset@example.com' });
    expect(missing.status).toBe(200);
    expect(sendWithResendMock).not.toHaveBeenCalled();

    sendWithResendMock.mockRejectedValueOnce(new Error('provider detail must not leak'));
    const activeForReset = await createActiveUser({
      organizationId: context.organizationId,
      email: 'reset-email-failure@example.com',
    });
    const failureResponse = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: activeForReset.email });
    expect(failureResponse.status).toBe(200);
    expect(failureResponse.body.message).toBe(missing.body.message);

    sendWithResendMock.mockRejectedValueOnce(new Error('provider detail must not leak'));
    const created = await createUserViaApi(context.token, {
      name: 'Email Failure User',
      email: 'email-failure-user@example.com',
    });
    expect(created.status).toBe(502);
    expect(created.body.code).toBe('USER_CREATED_EMAIL_FAILED');
    expect(created.body.message).not.toContain('provider detail');
    const user = await User.findOne({ email: 'email-failure-user@example.com' });
    expect(user).toBeTruthy();
    expect(user.passwordSetupRequired).toBe(true);
  });
});