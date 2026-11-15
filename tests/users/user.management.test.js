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
import ApprovalStep from '../../src/models/ApprovalStep.js';
import * as userServiceModule from '../../src/modules/users/user.service.js';
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
      assignmentScope: 'DEPARTMENT',
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
    const reusedSetupToken = await request(app).post('/api/auth/set-password').send({
      token: setupToken,
      password: TEST_PASSWORD,
      confirmPassword: TEST_PASSWORD,
    });
    expect(reusedSetupToken.status).toBe(400);
    expect(reusedSetupToken.body.code).toBe('INVALID_SETUP_TOKEN');

    const login = await loginRequest({ email: createdUser.email, password: TEST_PASSWORD });
    expect(login.status).toBe(200);
  });

  it('creates a department user with the built-in Department Member role using user-management permissions', async () => {
    const { organizationId, admin, token } = await createOrganizationContext('default-member-role');
    await Role.updateOne(
      { organizationId, name: ORGANIZATION_ADMIN_ROLE_NAME },
      { $set: { permissions: ['users.create', 'users.edit', 'roles.view', 'roles.create', 'roles.edit'] } }
    );
    const department = await Department.create({ organizationId, name: 'Default Member Department' });

    const response = await createUserViaApi(token, {
      name: 'Default Department Member',
      email: 'default-department-member@example.com',
      departmentId: String(department._id),
    });

    expect(response.status).toBe(201);
    const memberRole = await Role.findOne({ organizationId, roleType: 'EMPLOYEE' });
    expect(await UserRoleAssignment.exists({
      userId: response.body.data.id,
      organizationId,
      roleId: memberRole._id,
      scopeType: 'DEPARTMENT',
      departmentId: department._id,
      status: 'ACTIVE',
    })).toBeTruthy();
    expect(admin).toBeTruthy();
  });

  it('creates Department Managers without the default member role and preserves department membership', async () => {
    const { organizationId, token } = await createOrganizationContext('create-department-managers');
    const department = await Department.create({ organizationId, name: 'Manager Membership Department' });
    const managerRole = await Role.findOne({ organizationId, roleType: 'DEPARTMENT_MANAGER' });
    const users = [];

    for (const [name, email] of [
      ['Manager One', 'manager-one@example.com'],
      ['Manager Two', 'manager-two@example.com'],
    ]) {
      const response = await createUserViaApi(token, {
        name,
        email,
        departmentId: String(department._id),
        roleAssignments: [{
          roleId: String(managerRole._id),
          scopeType: 'DEPARTMENT',
          departmentId: String(department._id),
        }],
      });
      expect(response.status).toBe(201);
      users.push(response.body.data.id);

      const user = await User.findById(response.body.data.id);
      expect(String(user.organizationMemberships[0].departmentId)).toBe(String(department._id));
      expect(await UserRoleAssignment.countDocuments({
        userId: user._id,
        organizationId,
        roleId: managerRole._id,
        scopeType: 'DEPARTMENT',
        departmentId: department._id,
        status: 'ACTIVE',
      })).toBe(1);
    }

    expect(users).toHaveLength(2);
    const memberRole = await Role.findOne({ organizationId, roleType: 'EMPLOYEE' });
    expect(await UserRoleAssignment.countDocuments({
      userId: { $in: users },
      organizationId,
      roleId: memberRole._id,
      status: 'ACTIVE',
    })).toBe(0);
  });

  it('rejects invalid, inactive, and cross-organization selected roles atomically', async () => {
    const local = await createOrganizationContext('selected-role-validation');
    const foreign = await createOrganizationContext('selected-role-validation-foreign');
    const department = await Department.create({ organizationId: local.organizationId, name: 'Selected Role Department' });
    const inactiveRole = await Role.create({
      organizationId: local.organizationId,
      name: 'Inactive Custom Role',
      roleType: 'CUSTOM',
      permissions: ['users.view'],
      status: 'INACTIVE',
      createdBy: local.admin._id,
    });
    const foreignRole = await Role.findOne({
      organizationId: foreign.organizationId,
      roleType: 'DEPARTMENT_MANAGER',
    });
    const invalidRoleId = String(new mongoose.Types.ObjectId());
    const requestedRoles = [
      ['invalid', invalidRoleId, 'invalid-selected-role@example.com'],
      ['inactive', String(inactiveRole._id), 'inactive-selected-role@example.com'],
      ['foreign', String(foreignRole._id), 'foreign-selected-role@example.com'],
    ];

    for (const [label, roleId, email] of requestedRoles) {
      const response = await createUserViaApi(local.token, {
        name: `Selected ${label} role`,
        email,
        departmentId: String(department._id),
        roleAssignments: [{
          roleId,
          scopeType: 'DEPARTMENT',
          departmentId: String(department._id),
        }],
      });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_ROLE_ASSIGNMENT');
      expect(await User.exists({ email })).toBeNull();
    }
  });

  it('keeps Department Manager and Department Member mutually exclusive during user creation', async () => {
    const { organizationId, token } = await createOrganizationContext('selected-role-conflict');
    const department = await Department.create({ organizationId, name: 'Mutually Exclusive Department' });
    const managerRole = await Role.findOne({ organizationId, roleType: 'DEPARTMENT_MANAGER' });
    const memberRole = await Role.findOne({ organizationId, roleType: 'EMPLOYEE' });

    const response = await createUserViaApi(token, {
      name: 'Conflicting Manager',
      email: 'conflicting-manager@example.com',
      departmentId: String(department._id),
      roleAssignments: [
        {
          roleId: String(managerRole._id),
          scopeType: 'DEPARTMENT',
          departmentId: String(department._id),
        },
        {
          roleId: String(memberRole._id),
          scopeType: 'DEPARTMENT',
          departmentId: String(department._id),
        },
      ],
    });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('ROLE_COMPATIBILITY_CONFLICT');
    expect(await User.exists({ email: 'conflicting-manager@example.com' })).toBeNull();
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
      assignmentScope: 'ORGANIZATION',
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
      assignmentScope: 'ORGANIZATION',
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

  it('does not allow a non-admin with user-creation permission to assign the built-in Department Manager role', async () => {
    const { organizationId, admin } = await createOrganizationContext('built-in-manager-restriction');
    const department = await Department.create({ organizationId, name: 'Manager Role Department' });
    const userCreatorRole = await Role.create({
      organizationId,
      name: 'User Creator',
      roleType: 'CUSTOM',
      assignmentScope: 'ORGANIZATION',
      permissions: ['users.create'],
      status: 'ACTIVE',
      createdBy: admin._id,
    });
    const caller = await createActiveUser({
      organizationId,
      email: 'built-in-manager-restricted-caller@example.com',
    });
    await UserRoleAssignment.create({
      userId: caller._id,
      roleId: userCreatorRole._id,
      organizationId,
      departmentId: null,
      scopeType: 'ORGANIZATION',
      status: 'ACTIVE',
      assignedBy: admin._id,
    });
    const callerLogin = await loginRequest({ email: caller.email, password: TEST_PASSWORD });
    const managerRole = await Role.findOne({ organizationId, roleType: 'DEPARTMENT_MANAGER' });

    const response = await createUserViaApi(callerLogin.body.data.accessToken, {
      name: 'Unauthorized Manager',
      email: 'unauthorized-built-in-manager@example.com',
      departmentId: String(department._id),
      roleAssignments: [{
        roleId: String(managerRole._id),
        scopeType: 'DEPARTMENT',
        departmentId: String(department._id),
      }],
    });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('ROLE_ASSIGNMENT_FORBIDDEN');
    expect(await User.exists({ email: 'unauthorized-built-in-manager@example.com' })).toBeNull();
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
      assignmentScope: 'DEPARTMENT',
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
      assignmentScope: 'ORGANIZATION',
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

  it('reactivates a pending-setup membership without activating the global account', async () => {
    const { organizationId, token } = await createOrganizationContext('pending-reactivation');
    const target = await createActiveUser({
      organizationId,
      email: 'pending-reactivation@example.com',
    });
    await User.updateOne(
      { _id: target._id },
      {
        $set: {
          accountStatus: 'INACTIVE',
          passwordSetupRequired: true,
          'organizationMemberships.0.status': 'INACTIVE',
        },
      }
    );

    const response = await request(app)
      .patch(`/api/users/${target._id}/activate`)
      .set(authHeader(token));

    expect(response.status).toBe(200);
    const updated = await User.findById(target._id);
    expect(updated.accountStatus).toBe('INACTIVE');
    expect(updated.passwordSetupRequired).toBe(true);
    expect(updated.organizationMemberships[0].status).toBe('ACTIVE');
  });

  it('previews and imports multiple built-in role assignments for one user without duplicate users', async () => {
    const { organizationId, token } = await createOrganizationContext('bulk-import');
    const department = await Department.create({ organizationId, name: 'Bulk Engineering' });
    const csv = [
      'firstName,lastName,email,employeeId,department,role,designation,phone',
      'Bulk,User,bulk-user@example.com,,Bulk Engineering,Department Manager,,',
      'Bulk,User,bulk-user@example.com,,,Organization Admin,,',
    ].join('\r\n');

    const template = await request(app)
      .get('/api/users/bulk-import/template')
      .set(authHeader(token));
    expect(template.status).toBe(200);
    expect(template.headers['content-type']).toContain('text/csv');
    expect(template.text.startsWith('firstName,lastName,email,employeeId,department,role,designation,phone,scope\r\n')).toBe(true);
    expect(template.text).toContain('Repeat email for multiple roles');

    const preview = await request(app)
      .post('/api/users/bulk-import/validate')
      .set(authHeader(token))
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'bulk-users.csv', contentType: 'text/csv' });
    expect(preview.status).toBe(200);
    expect(preview.body.data.summary).toMatchObject({
      totalRows: 2,
      validUsers: 1,
      validAssignments: 2,
      invalidRows: 0,
    });
    expect(preview.body.data.rows.every((row) => row.status === 'VALID')).toBe(true);
    expect(await User.countDocuments({ email: 'bulk-user@example.com' })).toBe(0);

    const imported = await request(app)
      .post('/api/users/bulk-import/confirm')
      .set(authHeader(token))
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'bulk-users.csv', contentType: 'text/csv' });
    expect(imported.status).toBe(200);
    expect(imported.body.data.summary).toMatchObject({
      usersCreated: 1,
      assignmentsCreated: 2,
      existingUsersSkipped: 0,
      failedAssignments: 0,
      invitations: { sent: 1, failed: 0 },
    });
    expect(imported.body.data.errorReport).toMatchObject({
      contentType: 'text/csv',
      filename: expect.stringMatching(/errors\.csv$/),
    });
    const created = await User.findOne({ email: 'bulk-user@example.com' });
    expect(created.name).toBe('Bulk User');
    expect(await UserRoleAssignment.countDocuments({
      userId: created._id,
      organizationId,
      status: 'ACTIVE',
    })).toBe(2);
    expect(sendWithResendMock).toHaveBeenCalledOnce();

    const retry = await request(app)
      .post('/api/users/bulk-import/confirm')
      .set(authHeader(token))
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'bulk-users.csv', contentType: 'text/csv' });
    expect(retry.status).toBe(200);
    expect(retry.body.data.summary).toMatchObject({
      usersCreated: 0,
      assignmentsCreated: 0,
      existingUsersSkipped: 1,
      invitations: { sent: 0, failed: 0 },
    });
    expect(await User.countDocuments({ email: 'bulk-user@example.com' })).toBe(1);
    expect(sendWithResendMock).toHaveBeenCalledOnce();
  });

  it('returns a safe CSV report for invalid roles and rejects cross-organization references', async () => {
    const { organizationId, token } = await createOrganizationContext('bulk-invalid');
    const otherOrganizationId = new mongoose.Types.ObjectId();
    const platformAdmin = await createSuperAdmin({ email: 'bulk-report-platform@example.com' });
    await Organization.create({
      _id: otherOrganizationId,
      name: 'Other Bulk Organization',
      status: 'ACTIVE',
      createdBy: platformAdmin._id,
    });
    await Department.create({ organizationId: otherOrganizationId, name: 'Secret Department' });
    await Department.create({ organizationId, name: 'Inactive Bulk Department', status: 'INACTIVE' });
    await Role.create({
      organizationId,
      name: 'Custom Auditor',
      roleType: 'CUSTOM',
      permissions: ['users.view'],
      status: 'ACTIVE',
      createdBy: platformAdmin._id,
    });
    await Role.create({
      organizationId,
      name: 'Inactive Bulk Role',
      roleType: 'CUSTOM',
      assignmentScope: 'ORGANIZATION',
      permissions: ['users.view'],
      status: 'INACTIVE',
      createdBy: platformAdmin._id,
    });
    await Role.create({
      organizationId: otherOrganizationId,
      name: 'Foreign Bulk Role',
      roleType: 'CUSTOM',
      assignmentScope: 'ORGANIZATION',
      permissions: ['users.view'],
      status: 'ACTIVE',
      createdBy: platformAdmin._id,
    });
    await Role.create([
      {
        organizationId,
        name: 'Ambiguous Bulk Role',
        roleType: 'CUSTOM',
        assignmentScope: 'ORGANIZATION',
        permissions: ['users.view'],
        status: 'ACTIVE',
        createdBy: platformAdmin._id,
      },
      {
        organizationId,
        name: 'ambiguous bulk role',
        roleType: 'CUSTOM',
        assignmentScope: 'ORGANIZATION',
        permissions: ['users.view'],
        status: 'ACTIVE',
        createdBy: platformAdmin._id,
      },
    ]);
    const csv = [
      'firstName,lastName,email,employeeId,department,role,designation,phone',
      'Bad,Department,bad-department@example.com,,Secret Department,Department Manager,,',
      'Bad,Role,bad-role@example.com,,,Missing Role,,',
      'Custom,Role,custom-role@example.com,,,Custom Auditor,,',
      'Inactive,Department,inactive-department@example.com,,Inactive Bulk Department,Department Manager,,',
      'Inactive,Role,inactive-role@example.com,,,Inactive Bulk Role,,',
      'Foreign,Role,foreign-role@example.com,,,Foreign Bulk Role,,',
      'Ambiguous,Role,ambiguous-role@example.com,,,Ambiguous Bulk Role,,',
    ].join('\n');

    const preview = await request(app)
      .post('/api/users/bulk-import/validate')
      .set(authHeader(token))
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'invalid-users.csv', contentType: 'text/csv' });
    expect(preview.status).toBe(200);
    expect(preview.body.data.rows[0].status).toBe('INVALID');
    expect(preview.body.data.rows[0].errors.join(' ')).toContain('Department is not found or available');
    expect(preview.body.data.rows[0].errors.join(' ')).not.toContain(String(otherOrganizationId));
    expect(preview.body.data.rows[1].errors.join(' ')).toContain('Role is not found or available');
    expect(preview.body.data.rows[2].errors.join(' ')).toContain('no configured assignment scope');
    expect(preview.body.data.rows[3].errors.join(' ')).toContain('Department is inactive');
    expect(preview.body.data.rows[4].errors.join(' ')).toContain('Role is inactive');
    expect(preview.body.data.rows[5].errors.join(' ')).toContain('Role is not found or available');
    expect(preview.body.data.rows[5].errors.join(' ')).not.toContain('Foreign');
    expect(preview.body.data.rows[6].errors.join(' ')).toContain('Role name is ambiguous');

    const report = await request(app)
      .post('/api/users/bulk-import/failed-report')
      .set(authHeader(token))
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'invalid-users.csv', contentType: 'text/csv' });
    expect(report.status).toBe(200);
    expect(report.headers['content-type']).toContain('text/csv');
    expect(report.text).toContain('bad-role@example.com');
    expect(report.text).toContain('bad-department@example.com');
    expect(report.text).toContain('custom-role@example.com');
    expect(report.text).toContain('inactive-department@example.com');
    expect(report.text).toContain('inactive-role@example.com');
    expect(await User.countDocuments({ email: 'bad-role@example.com' })).toBe(0);
    expect(await UserRoleAssignment.countDocuments({ organizationId: otherOrganizationId })).toBe(0);
  });

  it('imports configured custom organization and department roles and audits partial failures safely', async () => {
    const { organizationId, token, admin } = await createOrganizationContext('bulk-custom-scopes');
    const department = await Department.create({ organizationId, name: 'Bulk Scope Department' });
    const createCustomRole = (name, assignmentScope) => request(app)
      .post('/api/roles')
      .set(authHeader(token))
      .send({ name, assignmentScope, permissions: ['users.view'] });
    const [organizationRole, departmentRole, dualScopeRole] = await Promise.all([
      createCustomRole('Bulk Organization Role', 'ORGANIZATION'),
      createCustomRole('Bulk Department Role', 'DEPARTMENT'),
      request(app)
        .post('/api/roles')
        .set(authHeader(token))
        .send({
          name: 'Bulk Dual Scope Role',
          assignmentScopes: ['ORGANIZATION', 'DEPARTMENT'],
          permissions: ['users.view'],
        }),
    ]);
    expect(organizationRole.status).toBe(201);
    expect(departmentRole.status).toBe(201);
    expect(organizationRole.body.data.assignmentScope).toBe('ORGANIZATION');
    expect(departmentRole.body.data.assignmentScope).toBe('DEPARTMENT');
    expect(dualScopeRole.body.data.assignmentScopes).toEqual(['ORGANIZATION', 'DEPARTMENT']);
    await Role.create({
      organizationId,
      name: 'Legacy Bulk Role',
      roleType: 'CUSTOM',
      assignmentScope: null,
      permissions: ['users.view'],
      status: 'ACTIVE',
      createdBy: admin._id,
    });

    const csv = [
      'firstName,lastName,email,employeeId,department,role,designation,phone,scope',
      'Bulk,Scope,bulk-custom-scope@example.com,,,Bulk Organization Role,,,',
      'Bulk,Scope,bulk-custom-scope@example.com,,Bulk Scope Department,Bulk Department Role,,,',
      'Bulk,Scope,bulk-custom-scope@example.com,,,Bulk Dual Scope Role,,,ORGANIZATION',
      'Bulk,Scope,bulk-custom-scope@example.com,,Bulk Scope Department,Bulk Dual Scope Role,,,DEPARTMENT',
      'Legacy,Scope,bulk-legacy-scope@example.com,,,Legacy Bulk Role,,,',
      'Ambiguous,Scope,bulk-dual-missing@example.com,,,Bulk Dual Scope Role,,,',
    ].join('\n');
    const response = await request(app)
      .post('/api/users/bulk-import/confirm')
      .set(authHeader(token))
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'custom-scopes.csv', contentType: 'text/csv' });
    expect(response.status).toBe(200);
    expect(response.body.data.summary).toMatchObject({
      usersCreated: 1,
      assignmentsCreated: 4,
      invalidUsersSkipped: 2,
      failedAssignments: 0,
    });
    expect(response.body.data.rows[0].status).toBe('IMPORTED');
    expect(response.body.data.rows[1].status).toBe('IMPORTED');
    expect(response.body.data.rows[2].status).toBe('IMPORTED');
    expect(response.body.data.rows[3].status).toBe('IMPORTED');
    expect(response.body.data.rows[4].errors.join(' ')).toContain('no configured assignment scope');
    expect(response.body.data.rows[5].errors.join(' ')).toContain('specify ORGANIZATION or DEPARTMENT');
    const importedUser = await User.findOne({ email: 'bulk-custom-scope@example.com' });
    const assignments = await UserRoleAssignment.find({
      userId: importedUser._id,
      organizationId,
      status: 'ACTIVE',
    }).populate('roleId', 'name assignmentScope assignmentScopes');
    expect(assignments).toHaveLength(4);
    expect(assignments.map(({ roleId, scopeType, departmentId }) => ({
      role: roleId.name,
      assignmentScope: roleId.assignmentScope,
      assignmentScopes: roleId.assignmentScopes,
      scopeType,
      departmentId: departmentId ? String(departmentId) : null,
    }))).toEqual(expect.arrayContaining([
      {
        role: 'Bulk Organization Role',
        assignmentScope: 'ORGANIZATION',
        assignmentScopes: ['ORGANIZATION'],
        scopeType: 'ORGANIZATION',
        departmentId: null,
      },
      {
        role: 'Bulk Department Role',
        assignmentScope: 'DEPARTMENT',
        assignmentScopes: ['DEPARTMENT'],
        scopeType: 'DEPARTMENT',
        departmentId: String(department._id),
      },
      {
        role: 'Bulk Dual Scope Role',
        assignmentScope: null,
        assignmentScopes: ['ORGANIZATION', 'DEPARTMENT'],
        scopeType: 'ORGANIZATION',
        departmentId: null,
      },
      {
        role: 'Bulk Dual Scope Role',
        assignmentScope: null,
        assignmentScopes: ['ORGANIZATION', 'DEPARTMENT'],
        scopeType: 'DEPARTMENT',
        departmentId: String(department._id),
      },
    ]));

    const importId = response.body.data.importId;
    const completedAudit = await AuditLog.findOne({
      resourceType: 'BulkUserImport',
      resourceId: importId,
      action: 'BULK_USER_IMPORT_COMPLETED_WITH_FAILURES',
    }).lean();
    expect(completedAudit.metadata.correlationId).toBe(importId);
    const auditText = JSON.stringify(await AuditLog.find({ resourceType: 'BulkUserImport' }).lean());
    expect(auditText).not.toContain(csv);
    expect(auditText).not.toContain('bulk-custom-scope@example.com');
    expect(auditText).not.toContain('bulk-legacy-scope@example.com');
    expect(auditText).not.toContain('"csv"');

    const invalidCsv = 'not,the,bulk,user,template';
    const failed = await request(app)
      .post('/api/users/bulk-import/confirm')
      .set(authHeader(token))
      .attach('file', Buffer.from(invalidCsv, 'utf8'), { filename: 'invalid.csv', contentType: 'text/csv' });
    expect(failed.status).toBe(400);
    expect(failed.body.code).toBe('BULK_IMPORT_CSV_INVALID');
    const failedAudit = await AuditLog.findOne({
      resourceType: 'BulkUserImport',
      action: 'BULK_USER_IMPORT_FAILED',
    }).sort({ timestamp: -1 }).lean();
    expect(failedAudit.metadata.correlationId).toBe(String(failedAudit.resourceId));
    expect(failedAudit.metadata.errorCode).toBe(failed.body.code);
    expect(JSON.stringify(failedAudit)).not.toContain(invalidCsv);
  });

  it('counts assignment failures when creation of a valid multi-role user group fails', async () => {
    const { organizationId, token, admin } = await createOrganizationContext('bulk-assignment-failure');
    const department = await Department.create({ organizationId, name: 'Failed Assignment Department' });
    await Role.create([
      {
        organizationId,
        name: 'Failed Assignment Role One',
        roleType: 'CUSTOM',
        assignmentScope: 'DEPARTMENT',
        permissions: ['users.view'],
        status: 'ACTIVE',
        createdBy: admin._id,
      },
      {
        organizationId,
        name: 'Failed Assignment Role Two',
        roleType: 'CUSTOM',
        assignmentScope: 'DEPARTMENT',
        permissions: ['users.view'],
        status: 'ACTIVE',
        createdBy: admin._id,
      },
    ]);
    const csv = [
      'firstName,lastName,email,employeeId,department,role,designation,phone',
      'Failed,Group,bulk-assignment-failure@example.com,,Failed Assignment Department,Failed Assignment Role One,,',
      'Failed,Group,bulk-assignment-failure@example.com,,Failed Assignment Department,Failed Assignment Role Two,,',
    ].join('\n');
    const createUserSpy = vi.spyOn(userServiceModule, 'createUser')
      .mockRejectedValueOnce(new Error('Internal test failure'));
    try {
      const response = await request(app)
        .post('/api/users/bulk-import/confirm')
        .set(authHeader(token))
        .attach('file', Buffer.from(csv, 'utf8'), { filename: 'failed-group.csv', contentType: 'text/csv' });
      expect(response.status).toBe(200);
      expect(response.body.data.summary).toMatchObject({
        usersCreated: 0,
        assignmentsCreated: 0,
        invalidUsersSkipped: 0,
        failedUsers: 1,
        failedAssignments: 2,
      });
      expect(response.body.data.rows).toHaveLength(2);
      expect(response.body.data.rows.every((row) => row.status === 'FAILED')).toBe(true);
      expect(response.body.data.errorReport.csv).toContain('Failed Assignment Role One');
      expect(response.body.data.errorReport.csv).toContain('Failed Assignment Role Two');
      expect(await User.exists({ email: 'bulk-assignment-failure@example.com' })).toBeNull();
      expect(await UserRoleAssignment.countDocuments({
        organizationId,
        roleId: { $in: await Role.find({ organizationId, name: /Failed Assignment Role/ }).distinct('_id') },
      })).toBe(0);
    } finally {
      createUserSpy.mockRestore();
    }
  });

  it('distinguishes existing identities and rejects conflicting or duplicate email groups without writes', async () => {
    const { organizationId, token } = await createOrganizationContext('bulk-identities');
    const foreign = await createOrganizationContext('bulk-identities-foreign');
    const department = await Department.create({ organizationId, name: 'Bulk Identity Department' });
    const existing = await createActiveUser({
      organizationId,
      email: 'bulk-existing-same-org@example.com',
    });
    const foreignUser = await createActiveUser({
      organizationId: foreign.organizationId,
      email: 'bulk-existing-other-org@example.com',
    });
    const memberRole = await Role.findOne({ organizationId, roleType: 'EMPLOYEE' });
    const csv = [
      'firstName,lastName,email,employeeId,department,role,designation,phone',
      'Same,Org,bulk-existing-same-org@example.com,,Bulk Identity Department,Department Member,,',
      'Other,Org,bulk-existing-other-org@example.com,,Bulk Identity Department,Department Member,,',
      'Conflict,Person,bulk-profile-conflict@example.com,,Bulk Identity Department,Department Member,,',
      'Different,Person,bulk-profile-conflict@example.com,,Bulk Identity Department,Department Manager,,',
      'Duplicate,Role,bulk-duplicate-role@example.com,,Bulk Identity Department,Department Member,,',
      'Duplicate,Role,bulk-duplicate-role@example.com,,Bulk Identity Department,Department Member,,',
    ].join('\n');
    const preview = await request(app)
      .post('/api/users/bulk-import/validate')
      .set(authHeader(token))
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'identities.csv', contentType: 'text/csv' });
    expect(preview.status).toBe(200);
    expect(preview.body.data.rows[0].status).toBe('EXISTING');
    expect(preview.body.data.rows[1].status).toBe('INVALID');
    expect(preview.body.data.rows[1].errors.join(' ')).toContain('already registered');
    expect(preview.body.data.rows[1].errors.join(' ')).not.toContain(String(foreign.organizationId));
    expect(preview.body.data.rows.slice(2, 4).every((row) =>
      row.errors.some((error) => error.includes('conflicting firstName'))
    )).toBe(true);
    expect(preview.body.data.rows[4].status).toBe('INVALID');
    expect(preview.body.data.rows[5].status).toBe('DUPLICATE');
    expect(preview.body.data.summary.invalidRows).toBe(5);
    expect(preview.body.data.summary.duplicateRows).toBe(1);
    expect(await User.countDocuments({ email: 'bulk-existing-same-org@example.com' })).toBe(1);
    expect(await User.countDocuments({ email: 'bulk-existing-other-org@example.com' })).toBe(1);
    expect(await User.countDocuments({ email: { $in: [
      'bulk-profile-conflict@example.com',
      'bulk-duplicate-role@example.com',
    ] } })).toBe(0);
    expect(await UserRoleAssignment.countDocuments({ userId: existing._id, roleId: memberRole._id })).toBe(0);
    expect(await User.exists({ _id: foreignUser._id })).toBeTruthy();
  });

  it('serializes concurrent confirmation of the same CSV without duplicate users, roles, or invitations', async () => {
    const { organizationId, token } = await createOrganizationContext('bulk-confirm-race');
    const department = await Department.create({ organizationId, name: 'Concurrent Bulk Department' });
    const csv = [
      'firstName,lastName,email,employeeId,department,role,designation,phone',
      'Concurrent,User,bulk-confirm-race@example.com,,Concurrent Bulk Department,Department Member,,',
    ].join('\n');
    const confirm = () => request(app)
      .post('/api/users/bulk-import/confirm')
      .set(authHeader(token))
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'concurrent.csv', contentType: 'text/csv' });

    const responses = await Promise.all([confirm(), confirm()]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responses.reduce((total, response) => total + response.body.data.summary.usersCreated, 0)).toBe(1);
    expect(responses.reduce((total, response) => total + response.body.data.summary.assignmentsCreated, 0)).toBe(1);
    expect(responses.reduce((total, response) => total + response.body.data.summary.existingUsersSkipped, 0)).toBe(1);
    const user = await User.findOne({ email: 'bulk-confirm-race@example.com' });
    const memberRole = await Role.findOne({ organizationId, roleType: 'EMPLOYEE' });
    expect(await User.countDocuments({ email: 'bulk-confirm-race@example.com' })).toBe(1);
    expect(await UserRoleAssignment.countDocuments({
      userId: user._id,
      organizationId,
      roleId: memberRole._id,
      departmentId: department._id,
      status: 'ACTIVE',
    })).toBe(1);
    expect(sendWithResendMock).toHaveBeenCalledOnce();
  });

  it('denies department-only user permissions on organization-wide bulk operations', async () => {
    const { organizationId, admin } = await createOrganizationContext('bulk-department-auth');
    const department = await Department.create({ organizationId, name: 'Bulk Auth Department' });
    const user = await createActiveUser({
      organizationId,
      email: 'bulk-department-only@example.com',
      departmentId: department._id,
    });
    const role = await Role.create({
      organizationId,
      name: 'Department Bulk Operator',
      roleType: 'CUSTOM',
      assignmentScope: 'DEPARTMENT',
      permissions: ['users.create', 'users.deactivate'],
      status: 'ACTIVE',
      createdBy: admin._id,
    });
    await UserRoleAssignment.create({
      userId: user._id,
      roleId: role._id,
      organizationId,
      departmentId: department._id,
      scopeType: 'DEPARTMENT',
      status: 'ACTIVE',
      assignedBy: admin._id,
    });
    const login = await loginRequest({ email: user.email, password: TEST_PASSWORD });
    const token = login.body.data.accessToken;
    const file = Buffer.from(
      'firstName,lastName,email,employeeId,department,role,designation,phone\nNew,User,new@example.com,,,Employee,,',
      'utf8'
    );

    const responses = await Promise.all([
      request(app).get('/api/users/bulk-import/template').set(authHeader(token)),
      request(app).post('/api/users/bulk-import/validate').set(authHeader(token))
        .attach('file', file, { filename: 'department-only.csv', contentType: 'text/csv' }),
      request(app).post('/api/users/bulk-import/confirm').set(authHeader(token))
        .attach('file', file, { filename: 'department-only.csv', contentType: 'text/csv' }),
      request(app).post('/api/users/bulk-import/failed-report').set(authHeader(token))
        .attach('file', file, { filename: 'department-only.csv', contentType: 'text/csv' }),
      request(app).post('/api/users/bulk-deactivate').set(authHeader(token))
        .send({ userIds: [String(user._id)] }),
      request(app).post('/api/users/bulk-membership-status').set(authHeader(token))
        .send({ userIds: [String(user._id)], status: 'ACTIVE' }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403, 403, 403]);
    expect(await User.exists({ email: 'new@example.com' })).toBeNull();
    expect((await User.findById(user._id)).organizationMemberships[0].status).toBe('ACTIVE');
  });

  it('bulk-deactivates eligible users, reports blocked users, and rejects duplicate IDs', async () => {
    const { organizationId, admin, token } = await createOrganizationContext('bulk-deactivate');
    const target = await createActiveUser({
      organizationId,
      email: 'bulk-deactivate-target@example.com',
    });
    const blocked = await createActiveUser({
      organizationId,
      email: 'bulk-deactivate-blocked@example.com',
    });
    const pending = await createActiveUser({
      organizationId,
      email: 'bulk-deactivate-pending@example.com',
    });
    await User.updateOne(
      { _id: blocked._id },
      {
        $push: {
          approvalDelegations: {
            organizationId,
            delegateId: admin._id,
            scopeType: 'ORGANIZATION',
            departmentId: null,
            stageIds: [],
            startsAt: new Date(Date.now() - 60_000),
            endsAt: new Date(Date.now() + 60_000),
            status: 'ACTIVE',
          },
        },
      }
    );
    await ApprovalStep.create({
      organizationId,
      requestId: new mongoose.Types.ObjectId(),
      attemptNumber: 1,
      workflowDefinitionId: new mongoose.Types.ObjectId(),
      workflowVersion: 1,
      stageId: 'pending-stage',
      sequence: 1,
      stageName: 'Pending approval',
      approverType: 'USER',
      approverId: pending._id,
      status: 'PENDING',
    });
    const otherOrganizationId = new mongoose.Types.ObjectId();
    const otherUser = await createActiveUser({
      organizationId: otherOrganizationId,
      email: 'bulk-deactivate-other@example.com',
    });

    const response = await request(app)
      .post('/api/users/bulk-deactivate')
      .set(authHeader(token))
      .send({ userIds: [String(target._id), String(blocked._id), String(pending._id), String(otherUser._id)] });
    expect(response.status).toBe(200);
    expect(response.body.data.summary).toMatchObject({ requested: 4, deactivated: 1, failed: 3 });
    expect(response.body.data.results.map((result) => result.status)).toEqual([
      'DEACTIVATED',
      'FAILED',
      'FAILED',
      'FAILED',
    ]);
    expect(response.body.data.results[1].code).toBe('ACTIVE_APPROVAL_DELEGATION');
    expect(response.body.data.results[2].code).toBe('PENDING_APPROVAL_RESPONSIBILITY');
    expect(response.body.data.results[3].message).toContain('not found');
    expect((await User.findById(target._id)).organizationMemberships[0].status).toBe('INACTIVE');
    expect((await User.findById(blocked._id)).organizationMemberships[0].status).toBe('ACTIVE');
    expect((await User.findById(pending._id)).organizationMemberships[0].status).toBe('ACTIVE');

    const duplicateIds = await request(app)
      .post('/api/users/bulk-deactivate')
      .set(authHeader(token))
      .send({ userIds: [String(target._id), String(target._id)] });
    expect(duplicateIds.status).toBe(400);
    expect(duplicateIds.body.code).toBe('VALIDATION_ERROR');
    expect(await AuditLog.countDocuments({ action: 'BULK_USER_DEACTIVATION_COMPLETED' })).toBe(1);
  });

  it('bulk-reactivates memberships, including pending-setup accounts, without changing global account state', async () => {
    const { organizationId, token } = await createOrganizationContext('bulk-reactivation');
    const pending = await createActiveUser({
      organizationId,
      email: 'bulk-reactivation-pending@example.com',
    });
    await User.updateOne(
      { _id: pending._id },
      {
        $set: {
          accountStatus: 'INACTIVE',
          passwordSetupRequired: true,
          'organizationMemberships.0.status': 'INACTIVE',
        },
      }
    );
    const alreadyActive = await createActiveUser({
      organizationId,
      email: 'bulk-reactivation-active@example.com',
    });
    const otherOrganizationUser = await createActiveUser({
      organizationId: new mongoose.Types.ObjectId(),
      email: 'bulk-reactivation-other@example.com',
    });

    const response = await request(app)
      .post('/api/users/bulk-membership-status')
      .set(authHeader(token))
      .send({
        userIds: [String(pending._id), String(alreadyActive._id), String(otherOrganizationUser._id)],
        status: 'ACTIVE',
      });

    expect(response.status).toBe(200);
    expect(response.body.data.summary).toEqual({
      requested: 3,
      activated: 1,
      deactivated: 0,
      failed: 1,
    });
    expect(response.body.data.results.map((result) => result.status)).toEqual([
      'ACTIVATED',
      'ALREADY_ACTIVE',
      'FAILED',
    ]);
    const updatedPending = await User.findById(pending._id);
    expect(updatedPending.accountStatus).toBe('INACTIVE');
    expect(updatedPending.passwordSetupRequired).toBe(true);
    expect(updatedPending.organizationMemberships[0].status).toBe('ACTIVE');

    const invalidStatus = await request(app)
      .post('/api/users/bulk-membership-status')
      .set(authHeader(token))
      .send({ userIds: [String(pending._id)], status: 'UNKNOWN' });
    expect(invalidStatus.status).toBe(400);

    const duplicateIds = await request(app)
      .post('/api/users/bulk-membership-status')
      .set(authHeader(token))
      .send({ userIds: [String(pending._id), String(pending._id)], status: 'ACTIVE' });
    expect(duplicateIds.status).toBe(400);
    expect(await AuditLog.countDocuments({ action: 'BULK_USER_MEMBERSHIP_STATUS_COMPLETED' })).toBe(1);
  });

  it('serializes concurrent admin deactivations so one capable Organization Admin remains', async () => {
    const { organizationId, admin, token } = await createOrganizationContext('bulk-admin-race');
    const secondAdmin = await createActiveUser({
      organizationId,
      email: 'second-bulk-admin@example.com',
    });
    const adminRole = await Role.findOne({ organizationId, name: ORGANIZATION_ADMIN_ROLE_NAME });
    await UserRoleAssignment.create({
      userId: secondAdmin._id,
      roleId: adminRole._id,
      organizationId,
      departmentId: null,
      scopeType: 'ORGANIZATION',
      status: 'ACTIVE',
      assignedBy: admin._id,
    });
    const secondLogin = await loginRequest({ email: secondAdmin.email, password: TEST_PASSWORD });
    expect(secondLogin.status).toBe(200);

    const [firstAttempt, secondAttempt] = await Promise.all([
      request(app)
        .post('/api/users/bulk-deactivate')
        .set(authHeader(token))
        .send({ userIds: [String(secondAdmin._id)] }),
      request(app)
        .post('/api/users/bulk-deactivate')
        .set(authHeader(secondLogin.body.data.accessToken))
        .send({ userIds: [String(admin._id)] }),
    ]);

    const firstStatus = firstAttempt.body.data?.results?.[0]?.status;
    const secondStatus = secondAttempt.body.data?.results?.[0]?.status;
    expect([firstStatus, secondStatus].filter((status) => status === 'DEACTIVATED')).toHaveLength(1);
    const activeMemberships = await User.find({
      _id: { $in: [admin._id, secondAdmin._id] },
      accountStatus: 'ACTIVE',
      organizationMemberships: { $elemMatch: { organizationId, status: 'ACTIVE' } },
    }).select('_id');
    expect(activeMemberships).toHaveLength(1);
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
    const userId = created.body.details.userId;
    expect(userId).toBeTruthy();
    const user = await User.findById(userId);
    expect(user).toBeTruthy();
    expect(user.passwordSetupRequired).toBe(true);
    const initialSetupHash = (await User.collection.findOne({ _id: user._id })).passwordSetupTokenHash;
    expect(initialSetupHash).toBeTruthy();

    const duplicate = await createUserViaApi(context.token, {
      name: 'Email Failure User',
      email: 'email-failure-user@example.com',
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('EMAIL_EXISTS');
    expect(await User.countDocuments({ email: 'email-failure-user@example.com' })).toBe(1);

    const retry = await request(app)
      .post(`/api/users/${userId}/password-reset`)
      .set(authHeader(context.token));
    expect(retry.status).toBe(200);
    expect(sendWithResendMock).toHaveBeenCalledTimes(3);
    const retrySetupToken = extractToken(sendWithResendMock.mock.calls.at(-1)[0].html, 'set-password');
    const updatedUser = await User.collection.findOne({ _id: user._id });
    expect(updatedUser.passwordSetupTokenHash).toBeTruthy();
    expect(updatedUser.passwordSetupTokenHash).not.toBe(initialSetupHash);
    expect(updatedUser.passwordSetupTokenHash).not.toBe(retrySetupToken);
    expect(updatedUser.passwordSetupTokenExpiresAt.getTime()).toBeGreaterThan(Date.now());

    const completedRetry = await request(app).post('/api/auth/set-password').send({
      token: retrySetupToken,
      password: TEST_PASSWORD,
      confirmPassword: TEST_PASSWORD,
    });
    expect(completedRetry.status).toBe(200);
    expect((await User.findById(user._id)).accountStatus).toBe('ACTIVE');
    const reusedRetryToken = await request(app).post('/api/auth/set-password').send({
      token: retrySetupToken,
      password: TEST_PASSWORD,
      confirmPassword: TEST_PASSWORD,
    });
    expect(reusedRetryToken.status).toBe(400);
    expect(reusedRetryToken.body.code).toBe('INVALID_SETUP_TOKEN');
  });
});