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
  const platformAdmin = await createSuperAdmin({ email: `role-platform-${suffix}@example.com` });
  const organizationId = new mongoose.Types.ObjectId();
  const admin = await createUser({
    email: `role-admin-${suffix}@example.com`,
    organizationMemberships: [{ organizationId, departmentId: null, status: 'ACTIVE' }],
  });
  const organization = await Organization.create({
    _id: organizationId,
    name: `Role Organization ${suffix}`,
    status: 'ACTIVE',
    createdBy: platformAdmin._id,
  });
  const adminRole = await Role.create({
    organizationId,
    name: ORGANIZATION_ADMIN_ROLE_NAME,
    roleType: 'ORGANIZATION_ADMIN',
    description: 'Organization administrator',
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
    roleId: adminRole._id,
    organizationId,
    departmentId: null,
    scopeType: 'ORGANIZATION',
    status: 'ACTIVE',
    assignedBy: platformAdmin._id,
  });
  const login = await loginRequest({ email: admin.email, password: TEST_PASSWORD });
  return { organization, organizationId, admin, adminRole, token: login.body.data.accessToken, platformAdmin };
};

const createActiveMember = async ({ organizationId, email, departmentId = null, accountStatus = 'ACTIVE' }) =>
  createUser({
    email,
    accountStatus,
    organizationMemberships: [{ organizationId, departmentId, status: 'ACTIVE' }],
  });

const createRole = async (token, body) =>
  request(app).post('/api/roles').set(authHeader(token)).send(body);

const assignRole = async (token, roleId, body) =>
  request(app).post(`/api/roles/${roleId}/assign`).set(authHeader(token)).send(body);

describe('Dynamic Role Management', () => {
  beforeAll(async () => {
    await connectTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await disconnectTestDatabase();
  });

  it('creates, searches, paginates, views, and updates organization-scoped roles', async () => {
    const { organizationId, token, admin } = await createOrganizationContext('crud');
    const created = await createRole(token, {
      name: 'Report Viewer',
      description: 'Read reports',
      roleType: 'CUSTOM',
      permissions: ['users.view', 'dashboard.view'],
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      organizationId: String(organizationId),
      name: 'Report Viewer',
      roleType: 'CUSTOM',
      permissions: ['users.view', 'dashboard.view'],
      status: 'ACTIVE',
      createdBy: String(admin._id),
    });

    const duplicate = await createRole(token, {
      name: 'report viewer',
      description: '',
      permissions: [],
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('ROLE_NAME_EXISTS');

    const invalidPermission = await createRole(token, {
      name: 'Unknown Permission Role',
      permissions: ['users.root'],
    });
    expect(invalidPermission.status).toBe(400);
    expect(invalidPermission.body.code).toBe('INVALID_PERMISSIONS');

    const list = await request(app)
      .get('/api/roles?page=1&limit=1&search=REPORT&status=ACTIVE&sortBy=name&sortOrder=asc')
      .set(authHeader(token));
    expect(list.status).toBe(200);
    expect(list.body.data.items).toHaveLength(1);
    expect(list.body.data.pagination.total).toBe(1);
    expect(list.body.data.items[0].assignmentCount).toBe(0);

    const detail = await request(app)
      .get(`/api/roles/${created.body.data.id}`)
      .set(authHeader(token));
    expect(detail.status).toBe(200);
    expect(detail.body.data.permissions).toEqual(['users.view', 'dashboard.view']);

    const updated = await request(app)
      .patch(`/api/roles/${created.body.data.id}`)
      .set(authHeader(token))
      .send({ name: 'Reports Reader', description: 'Read operational reports' });
    expect(updated.status).toBe(200);
    expect(updated.body.data.permissions).toEqual(['users.view', 'dashboard.view']);
    const anotherRole = await createRole(token, { name: 'Another Role', permissions: [] });
    const duplicateUpdate = await request(app)
      .patch(`/api/roles/${anotherRole.body.data.id}`)
      .set(authHeader(token))
      .send({ name: 'REPORTS READER' });
    expect(duplicateUpdate.status).toBe(409);
    expect(duplicateUpdate.body.code).toBe('ROLE_NAME_EXISTS');
    expect(await AuditLog.countDocuments({ action: 'ROLE_CREATED', resourceId: created.body.data.id })).toBe(1);
    expect(await AuditLog.countDocuments({ action: 'ROLE_UPDATED', resourceId: created.body.data.id })).toBe(1);
  });

  it('returns the centralized permission catalog and rejects non-admin and platform-only access', async () => {
    const local = await createOrganizationContext('auth-local');
    const foreign = await createOrganizationContext('auth-foreign');
    const role = await createRole(local.token, { name: 'Local Role', permissions: ['users.view'] });
    const member = await createActiveMember({ organizationId: local.organizationId, email: 'role-regular@example.com' });
    const memberLogin = await loginRequest({ email: member.email, password: TEST_PASSWORD });
    const superLogin = await loginRequest({ email: local.platformAdmin.email, password: TEST_PASSWORD });

    const catalog = await request(app)
      .get('/api/roles/permissions/catalog')
      .set(authHeader(local.token));
    expect(catalog.status).toBe(200);
    expect(catalog.body.data.modules.flatMap((module) => module.permissions.map((item) => item.id))).toContain('roles.edit');

    const regular = await request(app).get('/api/roles').set(authHeader(memberLogin.body.data.accessToken));
    expect(regular.status).toBe(403);
    const superAdmin = await request(app).get('/api/roles').set(authHeader(superLogin.body.data.accessToken));
    expect(superAdmin.status).toBe(403);
    const crossTenant = await request(app)
      .get(`/api/roles/${role.body.data.id}`)
      .set(authHeader(foreign.token));
    expect(crossTenant.status).toBe(404);
    expect((await request(app).get('/api/roles')).status).toBe(401);
  });

  it('assigns compatible scoped roles, rejects conflicts, and marks removed assignments inactive', async () => {
    const { organizationId, token, admin } = await createOrganizationContext('assign');
    const finance = await Department.create({ organizationId, name: 'Finance' });
    const hr = await Department.create({ organizationId, name: 'Human Resources' });
    const user = await createActiveMember({ organizationId, email: 'finance-employee@example.com' });
    const financeApprover = await createRole(token, {
      name: 'Finance Approver', roleType: 'CUSTOM', permissions: ['requests.view', 'requests.approve'],
    });
    const reportViewer = await createRole(token, {
      name: 'Report Viewer', roleType: 'CUSTOM', permissions: ['dashboard.view'],
    });
    const managerRole = await Role.findOne({ organizationId, roleType: 'DEPARTMENT_MANAGER' });
    const manager = { body: { data: { id: String(managerRole._id) } } };

    const financeAssignment = await assignRole(token, financeApprover.body.data.id, {
      userId: String(user._id), scopeType: 'DEPARTMENT', departmentId: String(finance._id),
    });
    expect(financeAssignment.status).toBe(201);
    const viewerAssignment = await assignRole(token, reportViewer.body.data.id, {
      userId: String(user._id), scopeType: 'ORGANIZATION',
    });
    expect(viewerAssignment.status).toBe(201);
    const managerAssignment = await assignRole(token, manager.body.data.id, {
      userId: String(user._id), scopeType: 'DEPARTMENT', departmentId: String(finance._id),
    });
    expect(managerAssignment.status).toBe(201);

    const multiDepartmentManager = await createActiveMember({
      organizationId,
      email: 'multi-department-manager@example.com',
    });
    const firstManagerAssignment = await assignRole(token, manager.body.data.id, {
      userId: String(multiDepartmentManager._id),
      scopeType: 'DEPARTMENT',
      departmentId: String(finance._id),
    });
    const secondManagerAssignment = await assignRole(token, manager.body.data.id, {
      userId: String(multiDepartmentManager._id),
      scopeType: 'DEPARTMENT',
      departmentId: String(hr._id),
    });
    expect(firstManagerAssignment.status).toBe(201);
    expect(secondManagerAssignment.status).toBe(201);

    const duplicate = await assignRole(token, reportViewer.body.data.id, {
      userId: String(user._id), scopeType: 'ORGANIZATION',
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('ROLE_ASSIGNMENT_EXISTS');

    const incompatibleEmployee = await Role.create({
      organizationId,
      name: 'Employee Designation',
      roleType: 'EMPLOYEE',
      permissions: ['users.view'],
      status: 'ACTIVE',
      createdBy: admin._id,
    });
    const conflict = await assignRole(token, String(incompatibleEmployee._id), {
      userId: String(user._id), scopeType: 'ORGANIZATION',
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('ROLE_COMPATIBILITY_CONFLICT');

    const incompatibleScope = await assignRole(token, manager.body.data.id, {
      userId: String(user._id), scopeType: 'DEPARTMENT', departmentId: String(hr._id),
    });
    expect(incompatibleScope.status).toBe(409);
    expect(incompatibleScope.body.code).toBe('ROLE_COMPATIBILITY_CONFLICT');

    const allAssignments = await request(app)
      .get(`/api/roles/users/${user._id}?page=1&limit=10`)
      .set(authHeader(token));
    expect(allAssignments.status).toBe(200);
    expect(allAssignments.body.data.items).toHaveLength(3);

    const roleUsers = await request(app)
      .get(`/api/roles/${financeApprover.body.data.id}/users?page=1&limit=10`)
      .set(authHeader(token));
    expect(roleUsers.status).toBe(200);
    expect(roleUsers.body.data.items[0].userId).toBe(String(user._id));

    const removed = await request(app)
      .delete(`/api/roles/${reportViewer.body.data.id}/assign/${user._id}`)
      .set(authHeader(token))
      .send({ scopeType: 'ORGANIZATION' });
    expect(removed.status).toBe(200);
    const savedAssignment = await UserRoleAssignment.findById(viewerAssignment.body.data.id);
    expect(savedAssignment.status).toBe('INACTIVE');
    expect(await AuditLog.countDocuments({ action: 'ROLE_ASSIGNED' })).toBe(5);
    expect(await AuditLog.countDocuments({ action: 'ROLE_UNASSIGNED' })).toBe(1);
    expect(await User.findById(user._id)).toBeTruthy();
    expect(admin).toBeTruthy();
  });

  it('allows authorized admins to assign built-in member and manager roles without weakening custom-role scope', async () => {
    const local = await createOrganizationContext('built-in-assignment');
    const foreign = await createOrganizationContext('built-in-assignment-foreign');
    const department = await Department.create({
      organizationId: local.organizationId,
      name: 'Built-in Assignment Department',
    });
    const member = await createActiveMember({
      organizationId: local.organizationId,
      email: 'built-in-member-target@example.com',
      departmentId: department._id,
    });
    const manager = await createActiveMember({
      organizationId: local.organizationId,
      email: 'built-in-manager-target@example.com',
      departmentId: department._id,
    });
    const customTarget = await createActiveMember({
      organizationId: local.organizationId,
      email: 'custom-role-target@example.com',
    });
    const foreignUser = await createActiveMember({
      organizationId: foreign.organizationId,
      email: 'foreign-built-in-target@example.com',
    });
    await Role.updateOne(
      { _id: local.adminRole._id },
      { $set: { permissions: ['users.create', 'users.edit', 'roles.view', 'roles.create', 'roles.edit'] } }
    );

    const memberRole = await Role.findOne({ organizationId: local.organizationId, roleType: 'EMPLOYEE' });
    const managerRole = await Role.findOne({ organizationId: local.organizationId, roleType: 'DEPARTMENT_MANAGER' });
    const memberAssignment = await assignRole(local.token, String(memberRole._id), {
      userId: String(member._id),
      scopeType: 'DEPARTMENT',
      departmentId: String(department._id),
    });
    const managerAssignment = await assignRole(local.token, String(managerRole._id), {
      userId: String(manager._id),
      scopeType: 'DEPARTMENT',
      departmentId: String(department._id),
    });
    expect(memberAssignment.status).toBe(201);
    expect(managerAssignment.status).toBe(201);

    const elevatedCustomRole = await createRole(local.token, {
      name: 'Out of Scope Custom Role',
      permissions: ['users.deactivate'],
    });
    const customAssignment = await assignRole(local.token, elevatedCustomRole.body.data.id, {
      userId: String(customTarget._id),
      scopeType: 'ORGANIZATION',
    });
    expect(customAssignment.status).toBe(403);
    expect(customAssignment.body.code).toBe('ROLE_ASSIGNMENT_FORBIDDEN');

    const crossOrganization = await assignRole(local.token, String(memberRole._id), {
      userId: String(foreignUser._id),
      scopeType: 'DEPARTMENT',
      departmentId: String(department._id),
    });
    expect(crossOrganization.status).toBe(400);
    expect(crossOrganization.body.code).toBe('INVALID_ROLE_USER');
  });

  it('enforces department role scope and validates users, departments, and organizations', async () => {
    const local = await createOrganizationContext('scope-local');
    const foreign = await createOrganizationContext('scope-foreign');
    const localDepartment = await Department.create({ organizationId: local.organizationId, name: 'Local Dept' });
    const foreignDepartment = await Department.create({ organizationId: foreign.organizationId, name: 'Foreign Dept' });
    const role = await createRole(local.token, { name: 'Scoped Viewer', permissions: ['users.view'] });
    const localUser = await createActiveMember({ organizationId: local.organizationId, email: 'local-role-user@example.com' });
    const foreignUser = await createActiveMember({ organizationId: foreign.organizationId, email: 'foreign-role-user@example.com' });

    const badUser = await assignRole(local.token, role.body.data.id, {
      userId: String(foreignUser._id), scopeType: 'ORGANIZATION',
    });
    expect(badUser.status).toBe(400);
    expect(badUser.body.code).toBe('INVALID_ROLE_USER');

    const badDepartment = await assignRole(local.token, role.body.data.id, {
      userId: String(localUser._id), scopeType: 'DEPARTMENT', departmentId: String(foreignDepartment._id),
    });
    expect(badDepartment.status).toBe(400);
    expect(badDepartment.body.code).toBe('INVALID_ROLE_DEPARTMENT');

    const inactiveDepartment = await Department.create({
      organizationId: local.organizationId,
      name: 'Inactive Dept',
      status: 'INACTIVE',
    });
    const inactiveScope = await assignRole(local.token, role.body.data.id, {
      userId: String(localUser._id), scopeType: 'DEPARTMENT', departmentId: String(inactiveDepartment._id),
    });
    expect(inactiveScope.status).toBe(400);

    const valid = await assignRole(local.token, role.body.data.id, {
      userId: String(localUser._id), scopeType: 'DEPARTMENT', departmentId: String(localDepartment._id),
    });
    expect(valid.status).toBe(201);
  });

  it('applies role deactivation, permission updates, reactivation, and unassignment immediately to existing tokens', async () => {
    const { organizationId, token } = await createOrganizationContext('revoke');
    const user = await createActiveMember({ organizationId, email: 'live-permission-user@example.com' });
    const role = await createRole(token, {
      name: 'User Reader',
      permissions: ['users.view', 'dashboard.view'],
    });
    const otherRole = await createRole(token, {
      name: 'Dashboard Reader',
      permissions: ['dashboard.view'],
    });
    await assignRole(token, role.body.data.id, { userId: String(user._id), scopeType: 'ORGANIZATION' });
    await assignRole(token, otherRole.body.data.id, { userId: String(user._id), scopeType: 'ORGANIZATION' });
    const login = await loginRequest({ email: user.email, password: TEST_PASSWORD });
    const existingToken = login.body.data.accessToken;
    const usersEndpoint = () => request(app).get('/api/users').set(authHeader(existingToken));

    expect((await usersEndpoint()).status).toBe(200);

    const changed = await request(app)
      .patch(`/api/roles/${role.body.data.id}/permissions`)
      .set(authHeader(token))
      .send({ permissions: ['dashboard.view'] });
    expect(changed.status).toBe(200);
    expect((await usersEndpoint()).status).toBe(403);
    expect(await AuditLog.countDocuments({ action: 'ROLE_PERMISSIONS_UPDATED', resourceId: role.body.data.id })).toBe(1);

    const expanded = await request(app)
      .patch(`/api/roles/${role.body.data.id}/permissions`)
      .set(authHeader(token))
      .send({ permissions: ['users.view', 'dashboard.view'] });
    expect(expanded.status).toBe(200);
    expect((await usersEndpoint()).status).toBe(200);

    const deactivated = await request(app)
      .patch(`/api/roles/${role.body.data.id}/deactivate`)
      .set(authHeader(token));
    expect(deactivated.status).toBe(200);
    expect((await usersEndpoint()).status).toBe(403);
    expect((await loginRequest({ email: user.email, password: TEST_PASSWORD })).status).toBe(200);
    expect(await AuditLog.countDocuments({ action: 'ROLE_DEACTIVATED', resourceId: role.body.data.id })).toBe(1);

    const reactivated = await request(app)
      .patch(`/api/roles/${role.body.data.id}/activate`)
      .set(authHeader(token));
    expect(reactivated.status).toBe(200);
    expect((await usersEndpoint()).status).toBe(200);
    expect(await AuditLog.countDocuments({ action: 'ROLE_ACTIVATED', resourceId: role.body.data.id })).toBe(1);

    const removed = await request(app)
      .delete(`/api/roles/${role.body.data.id}/assign/${user._id}`)
      .set(authHeader(token))
      .send({ scopeType: 'ORGANIZATION' });
    expect(removed.status).toBe(200);
    expect((await usersEndpoint()).status).toBe(403);
    expect((await loginRequest({ email: user.email, password: TEST_PASSWORD })).status).toBe(200);
    expect(await UserRoleAssignment.countDocuments({
      userId: user._id,
      roleId: otherRole.body.data.id,
      status: 'ACTIVE',
    })).toBe(1);
    expect(await AuditLog.countDocuments({ action: 'ROLE_UNASSIGNED', resourceId: role.body.data.id })).toBe(1);
  });

  it('prevents administrative lockout and protects built-in Organization Admin identity', async () => {
    const { organizationId, adminRole, token, admin } = await createOrganizationContext('lockout');
    const removeAccess = await request(app)
      .patch(`/api/roles/${adminRole._id}/permissions`)
      .set(authHeader(token))
      .send({ permissions: ['users.view'] });
    expect(removeAccess.status).toBe(409);
    expect(removeAccess.body.code).toBe('BUILT_IN_ROLE_PROTECTED');

    const deactivateAdminRole = await request(app)
      .patch(`/api/roles/${adminRole._id}/deactivate`)
      .set(authHeader(token));
    expect(deactivateAdminRole.status).toBe(409);
    expect((await Role.findById(adminRole._id)).status).toBe('ACTIVE');

    const removeAdminAssignment = await request(app)
      .delete(`/api/roles/${adminRole._id}/assign/${admin._id}`)
      .set(authHeader(token))
      .send({ scopeType: 'ORGANIZATION' });
    expect(removeAdminAssignment.status).toBe(409);
    expect(await UserRoleAssignment.countDocuments({ userId: admin._id, organizationId, status: 'ACTIVE' })).toBe(1);
  });

  it('preserves User Management last-admin protection after the built-in role is renamed', async () => {
    const { organizationId, adminRole, token, admin } = await createOrganizationContext('admin-rename');
    const operator = await createActiveMember({
      organizationId,
      email: 'admin-rename-operator@example.com',
    });
    const operatorRole = await Role.create({
      organizationId,
      name: 'Membership Operator',
      roleType: 'CUSTOM',
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

    const renamed = await request(app)
      .patch(`/api/roles/${adminRole._id}`)
      .set(authHeader(token))
      .send({ name: 'Tenant Administrator' });
    expect(renamed.status).toBe(409);
    expect(renamed.body.code).toBe('BUILT_IN_ROLE_PROTECTED');

    const deactivate = await request(app)
      .patch(`/api/users/${admin._id}/deactivate`)
      .set(authHeader(operatorLogin.body.data.accessToken));
    expect(deactivate.status).toBe(409);
    expect(deactivate.body.code).toBe('LAST_ORGANIZATION_ADMIN');
  });

  it('manages the same role independently at different scopes and allows reassignment after unassignment', async () => {
    const { organizationId, token } = await createOrganizationContext('assignment-history');
    const firstDepartment = await Department.create({ organizationId, name: 'First Department' });
    const secondDepartment = await Department.create({ organizationId, name: 'Second Department' });
    const user = await createActiveMember({ organizationId, email: 'assignment-history@example.com' });
    const role = await createRole(token, { name: 'Scoped Reader', permissions: ['users.view'] });

    const organizationAssignment = await assignRole(token, role.body.data.id, {
      userId: String(user._id), scopeType: 'ORGANIZATION',
    });
    const departmentAssignment = await assignRole(token, role.body.data.id, {
      userId: String(user._id), scopeType: 'DEPARTMENT', departmentId: String(firstDepartment._id),
    });
    expect(organizationAssignment.status).toBe(201);
    expect(departmentAssignment.status).toBe(201);

    const removed = await request(app)
      .delete(`/api/roles/${role.body.data.id}/assign/${user._id}`)
      .set(authHeader(token))
      .send({ scopeType: 'DEPARTMENT', departmentId: String(firstDepartment._id) });
    expect(removed.status).toBe(200);

    const reassigned = await assignRole(token, role.body.data.id, {
      userId: String(user._id), scopeType: 'DEPARTMENT', departmentId: String(secondDepartment._id),
    });
    expect(reassigned.status).toBe(201);
    expect(await UserRoleAssignment.countDocuments({
      userId: user._id,
      roleId: role.body.data.id,
      status: 'INACTIVE',
      departmentId: firstDepartment._id,
    })).toBe(1);
    expect(await UserRoleAssignment.countDocuments({
      userId: user._id,
      roleId: role.body.data.id,
      status: 'ACTIVE',
    })).toBe(2);
  });

  it('rejects assignments to deactivated departments and invalid role scopes', async () => {
    const { organizationId, token } = await createOrganizationContext('assignment-validation');
    const department = await Department.create({ organizationId, name: 'Disabled Department' });
    const user = await createActiveMember({ organizationId, email: 'assignment-validation@example.com' });
    const managerRole = await Role.findOne({ organizationId, roleType: 'DEPARTMENT_MANAGER' });
    const manager = { body: { data: { id: String(managerRole._id) } } };

    const invalidScope = await assignRole(token, manager.body.data.id, {
      userId: String(user._id), scopeType: 'ORGANIZATION',
    });
    expect(invalidScope.status).toBe(400);
    expect(invalidScope.body.code).toBe('INVALID_ROLE_SCOPE');

    await Department.updateOne({ _id: department._id }, { $set: { status: 'INACTIVE' } });
    const inactiveDepartment = await assignRole(token, manager.body.data.id, {
      userId: String(user._id), scopeType: 'DEPARTMENT', departmentId: String(department._id),
    });
    expect(inactiveDepartment.status).toBe(400);
    expect(inactiveDepartment.body.code).toBe('INVALID_ROLE_DEPARTMENT');
  });
});
