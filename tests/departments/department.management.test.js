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
import { ORGANIZATION_ADMIN_PERMISSIONS, ORGANIZATION_ADMIN_ROLE_NAME } from '../../src/config/constants.js';

const authHeader = (token) => ({ Authorization: `Bearer ${token}` });

const createRoleAssignment = async ({ userId, organizationId, roleName, permissions, scopeType = 'ORGANIZATION', departmentId = null, assignedBy }) => {
  const role = await Role.create({
    organizationId,
    name: roleName,
    description: '',
    permissions,
    status: 'ACTIVE',
    createdBy: assignedBy,
  });
  await UserRoleAssignment.create({
    userId,
    roleId: role._id,
    organizationId,
    departmentId,
    scopeType,
    status: 'ACTIVE',
    assignedBy,
  });
  return role;
};

const createOrganizationContext = async (suffix = 'one') => {
  const organizationId = new mongoose.Types.ObjectId();
  const admin = await createUser({
    name: 'Organization Admin',
    email: `admin-${suffix}@example.com`,
    organizationMemberships: [
      { organizationId, departmentId: null, status: 'ACTIVE' },
    ],
  });
  await Organization.create({
    _id: organizationId,
    name: `Organization ${suffix}`,
    status: 'ACTIVE',
    createdBy: admin._id,
  });
  await createRoleAssignment({
    userId: admin._id,
    organizationId,
    roleName: ORGANIZATION_ADMIN_ROLE_NAME,
    permissions: ORGANIZATION_ADMIN_PERMISSIONS,
    assignedBy: admin._id,
  });
  const login = await loginRequest({ email: admin.email, password: TEST_PASSWORD });
  return { organizationId, admin, token: login.body.data.accessToken };
};

const createDepartment = async (token, body = { name: 'Engineering' }) =>
  request(app).post('/api/departments').set(authHeader(token)).send(body);

const createMember = async ({ email, organizationId, departmentId = null, status = 'ACTIVE', accountStatus = 'ACTIVE', additionalMemberships = [] }) =>
  createUser({
    email,
    accountStatus,
    organizationMemberships: [
      { organizationId, departmentId, status },
      ...additionalMemberships,
    ],
  });

describe('Department management', () => {
  beforeAll(async () => {
    await connectTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await disconnectTestDatabase();
  });

  it('creates a tenant-owned department and records an audit event', async () => {
    const { organizationId, admin, token } = await createOrganizationContext();
    const response = await createDepartment(token, {
      name: '  Engineering  ',
      description: '  Product engineering  ',
    });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      organizationId: String(organizationId),
      name: 'Engineering',
      description: 'Product engineering',
      status: 'ACTIVE',
      managerCount: 0,
      memberCount: 0,
    });
    expect(await Department.countDocuments({ organizationId })).toBe(1);
    expect(await AuditLog.findOne({
      actorId: admin._id,
      action: 'DEPARTMENT_CREATED',
      resourceId: response.body.data.id,
    })).toBeTruthy();
  });

  it('rejects invalid create fields and duplicate names within one organization', async () => {
    const { organizationId, token } = await createOrganizationContext();
    for (const body of [{}, { name: '   ' }, { name: 'A' }, { name: 'Valid', organizationId }]) {
      const response = await createDepartment(token, body);
      expect(response.status).toBe(400);
    }

    expect((await createDepartment(token, { name: 'Same Name' })).status).toBe(201);
    const duplicate = await createDepartment(token, { name: 'Same Name' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('DEPARTMENT_NAME_EXISTS');
    expect(await Department.countDocuments({ organizationId })).toBe(1);
  });

  it('allows the same department name in another organization and isolates lists', async () => {
    const first = await createOrganizationContext('first');
    const second = await createOrganizationContext('second');
    await createDepartment(first.token, { name: 'Engineering' });
    await createDepartment(second.token, { name: 'Engineering' });

    const response = await request(app)
      .get('/api/departments?search=engineering&status=ACTIVE&sortBy=name&sortOrder=asc')
      .set(authHeader(first.token));
    expect(response.status).toBe(200);
    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0].organizationId).toBe(String(first.organizationId));
    expect(response.body.data.pagination.total).toBe(1);
  });

  it('validates pagination and returns an empty page consistently', async () => {
    const { token } = await createOrganizationContext();
    const invalid = await request(app)
      .get('/api/departments?page=1&page=2')
      .set(authHeader(token));
    expect(invalid.status).toBe(400);

    const empty = await request(app)
      .get('/api/departments?page=2&limit=5')
      .set(authHeader(token));
    expect(empty.status).toBe(200);
    expect(empty.body.data.items).toEqual([]);
    expect(empty.body.data.pagination.total).toBe(0);
  });

  it('returns details and safe member data while hiding other-tenant departments', async () => {
    const first = await createOrganizationContext('detail');
    const other = await createOrganizationContext('other');
    const created = await createDepartment(first.token);
    const departmentId = created.body.data.id;
    const member = await createMember({ email: 'member-detail@example.com', organizationId: first.organizationId });
    member.organizationMemberships[0].departmentId = departmentId;
    await member.save();
    const otherDepartment = await createDepartment(other.token, { name: 'Private' });

    const details = await request(app)
      .get(`/api/departments/${departmentId}`)
      .set(authHeader(first.token));
    expect(details.status).toBe(200);
    expect(details.body.data.summary.memberCount).toBe(1);
    expect(details.body.data.members[0]).toMatchObject({ id: String(member._id), email: member.email });
    expect(details.body.data.members[0].passwordHash).toBeUndefined();

    const crossTenant = await request(app)
      .get(`/api/departments/${otherDepartment.body.data.id}`)
      .set(authHeader(first.token));
    expect(crossTenant.status).toBe(404);
    expect(crossTenant.body.code).toBe('DEPARTMENT_NOT_FOUND');
  });

  it('updates only name and description, logs changes, and rejects duplicate or unsupported fields', async () => {
    const { token } = await createOrganizationContext('update');
    const first = await createDepartment(token, { name: 'Engineering' });
    await createDepartment(token, { name: 'Product' });

    const updated = await request(app)
      .patch(`/api/departments/${first.body.data.id}`)
      .set(authHeader(token))
      .send({ name: 'Platform', description: 'Core services' });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({ name: 'Platform', description: 'Core services' });

    const duplicate = await request(app)
      .patch(`/api/departments/${first.body.data.id}`)
      .set(authHeader(token))
      .send({ name: 'Product' });
    expect(duplicate.status).toBe(409);

    for (const body of [{ managerIds: [] }, { status: 'INACTIVE' }, { organizationId: new mongoose.Types.ObjectId() }, {}]) {
      const invalid = await request(app)
        .patch(`/api/departments/${first.body.data.id}`)
        .set(authHeader(token))
        .send(body);
      expect(invalid.status).toBe(400);
    }

    const audit = await AuditLog.findOne({ resourceId: first.body.data.id, action: 'DEPARTMENT_UPDATED' });
    expect(audit.changes.name).toEqual({ from: 'Engineering', to: 'Platform' });
  });

  it('requires an existing departments.edit assignment for manager eligibility and replaces the full list', async () => {
    const { organizationId, admin, token } = await createOrganizationContext('manager');
    const created = await createDepartment(token);
    const departmentId = created.body.data.id;
    const managerA = await createMember({ email: 'manager-a@example.com', organizationId });
    const managerB = await createMember({ email: 'manager-b@example.com', organizationId });
    const outsider = await createMember({ email: 'manager-no-role@example.com', organizationId });

    const ineligible = await request(app)
      .patch(`/api/departments/${departmentId}/managers`)
      .set(authHeader(token))
      .send({ managerIds: [String(outsider._id)] });
    expect(ineligible.status).toBe(403);
    expect(ineligible.body.code).toBe('MANAGER_NOT_ELIGIBLE');

    await createRoleAssignment({
      userId: managerA._id,
      organizationId,
      roleName: 'Manager A Editor',
      permissions: ['departments.edit'],
      assignedBy: admin._id,
    });
    await createRoleAssignment({
      userId: managerB._id,
      organizationId,
      roleName: 'Manager B Editor',
      permissions: ['departments.edit'],
      assignedBy: admin._id,
    });

    const assigned = await request(app)
      .patch(`/api/departments/${departmentId}/managers`)
      .set(authHeader(token))
      .send({ managerIds: [String(managerA._id), String(managerB._id)] });
    expect(assigned.status).toBe(200);
    expect(assigned.body.data.managerCount).toBe(2);
    expect((await Department.findById(departmentId)).managerIds.map(String)).toEqual([
      String(managerA._id),
      String(managerB._id),
    ]);

    const replaced = await request(app)
      .patch(`/api/departments/${departmentId}/managers`)
      .set(authHeader(token))
      .send({ managerIds: [String(managerB._id)] });
    expect(replaced.status).toBe(200);
    expect((await Department.findById(departmentId)).managerIds.map(String)).toEqual([String(managerB._id)]);
    expect(await AuditLog.countDocuments({ action: 'DEPARTMENT_MANAGER_ASSIGNED', resourceId: departmentId })).toBe(2);
    expect(await AuditLog.countDocuments({ action: 'DEPARTMENT_MANAGER_REMOVED', resourceId: departmentId })).toBe(1);
  });

  it('limits department-scoped permissions to the assigned department', async () => {
    const { organizationId, admin, token } = await createOrganizationContext('scoped-access');
    const departmentA = await createDepartment(token, { name: 'Scoped A' });
    const departmentB = await createDepartment(token, { name: 'Scoped B' });
    const scopedUser = await createMember({ email: 'scoped-editor@example.com', organizationId });
    await createRoleAssignment({
      userId: scopedUser._id,
      organizationId,
      roleName: 'Scoped Department Editor',
      permissions: ['departments.view', 'departments.edit'],
      assignedBy: admin._id,
      scopeType: 'DEPARTMENT',
      departmentId: departmentA.body.data.id,
    });
    const login = await loginRequest({ email: scopedUser.email, password: TEST_PASSWORD });
    const scopedToken = login.body.data.accessToken;

    const list = await request(app).get('/api/departments').set(authHeader(scopedToken));
    expect(list.status).toBe(200);
    expect(list.body.data.items.map((item) => item.id)).toEqual([departmentA.body.data.id]);

    const allowed = await request(app)
      .patch(`/api/departments/${departmentA.body.data.id}`)
      .set(authHeader(scopedToken))
      .send({ name: 'Scoped A Updated' });
    expect(allowed.status).toBe(200);

    const denied = await request(app)
      .patch(`/api/departments/${departmentB.body.data.id}`)
      .set(authHeader(scopedToken))
      .send({ name: 'Scoped B Hijack' });
    expect(denied.status).toBe(403);
  });

  it('rejects invalid, duplicate, foreign, inactive, or unassigned managers', async () => {
    const local = await createOrganizationContext('manager-check');
    const foreign = await createOrganizationContext('foreign-manager');
    const created = await createDepartment(local.token);
    const active = await createMember({ email: 'eligible-manager@example.com', organizationId: local.organizationId });
    const inactive = await createMember({ email: 'inactive-manager@example.com', organizationId: local.organizationId, accountStatus: 'INACTIVE' });
    const foreignUser = await createMember({ email: 'foreign-manager@example.com', organizationId: foreign.organizationId });
    await createRoleAssignment({
      userId: active._id,
      organizationId: local.organizationId,
      roleName: 'Scoped Manager',
      permissions: ['departments.edit'],
      assignedBy: local.admin._id,
      scopeType: 'DEPARTMENT',
      departmentId: created.body.data.id,
    });

    const invalidId = await request(app)
      .patch(`/api/departments/${created.body.data.id}/managers`)
      .set(authHeader(local.token))
      .send({ managerIds: ['not-an-object-id'] });
    expect(invalidId.status).toBe(400);

    const duplicateIds = await request(app)
      .patch(`/api/departments/${created.body.data.id}/managers`)
      .set(authHeader(local.token))
      .send({ managerIds: [String(active._id), String(active._id).toUpperCase()] });
    expect(duplicateIds.status).toBe(400);

    for (const userId of [inactive._id, foreignUser._id]) {
      const rejected = await request(app)
        .patch(`/api/departments/${created.body.data.id}/managers`)
        .set(authHeader(local.token))
        .send({ managerIds: [String(userId)] });
      expect([400, 403]).toContain(rejected.status);
    }

    const scopedAssignment = await request(app)
      .patch(`/api/departments/${created.body.data.id}/managers`)
      .set(authHeader(local.token))
      .send({ managerIds: [String(active._id)] });
    expect(scopedAssignment.status).toBe(200);
  });

  it('adds members atomically to embedded memberships and removes without deleting users or other org memberships', async () => {
    const { organizationId, token } = await createOrganizationContext('member');
    const otherOrgId = new mongoose.Types.ObjectId();
    const otherOrgUser = await createUser({
      email: 'multi-org-member@example.com',
      organizationMemberships: [
        { organizationId, departmentId: null, status: 'ACTIVE' },
        { organizationId: otherOrgId, departmentId: new mongoose.Types.ObjectId(), status: 'ACTIVE' },
      ],
    });
    const second = await createMember({ email: 'second-member@example.com', organizationId });
    const inactive = await createMember({
      email: 'inactive-member@example.com',
      organizationId,
      accountStatus: 'INACTIVE',
    });
    const department = await createDepartment(token);
    const departmentId = department.body.data.id;

    const inactiveAttempt = await request(app)
      .post(`/api/departments/${departmentId}/members`)
      .set(authHeader(token))
      .send({ userIds: [String(inactive._id)] });
    expect(inactiveAttempt.status).toBe(400);

    const added = await request(app)
      .post(`/api/departments/${departmentId}/members`)
      .set(authHeader(token))
      .send({ userIds: [String(otherOrgUser._id), String(second._id)] });
    expect(added.status).toBe(200);
    const savedUser = await User.findById(otherOrgUser._id);
    expect(String(savedUser.organizationMemberships[0].departmentId)).toBe(departmentId);
    expect(savedUser.organizationMemberships[1].departmentId).toBeTruthy();

    const duplicate = await request(app)
      .post(`/api/departments/${departmentId}/members`)
      .set(authHeader(token))
      .send({ userIds: [String(otherOrgUser._id)] });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('MEMBER_ALREADY_ASSIGNED');

    const removed = await request(app)
      .delete(`/api/departments/${departmentId}/members/${otherOrgUser._id}`)
      .set(authHeader(token));
    expect(removed.status).toBe(200);
    const afterRemoval = await User.findById(otherOrgUser._id);
    expect(afterRemoval).toBeTruthy();
    expect(afterRemoval.organizationMemberships[0].departmentId).toBeNull();
    expect(afterRemoval.organizationMemberships[1].departmentId).toBeTruthy();
    expect(await AuditLog.countDocuments({ action: 'DEPARTMENT_MEMBER_ADDED', resourceId: departmentId })).toBe(2);
    expect(await AuditLog.countDocuments({ action: 'DEPARTMENT_MEMBER_REMOVED', resourceId: departmentId })).toBe(1);
  });

  it('rolls back a batch member addition if any user is invalid or already assigned elsewhere', async () => {
    const { organizationId, token } = await createOrganizationContext('rollback');
    const first = await createMember({ email: 'rollback-first@example.com', organizationId });
    const secondDepartment = await createDepartment(token, { name: 'Second Department' });
    const otherDepartment = await createDepartment(token, { name: 'Other Department' });
    const occupied = await createMember({
      email: 'occupied@example.com',
      organizationId,
      departmentId: secondDepartment.body.data.id,
    });

    const response = await request(app)
      .post(`/api/departments/${otherDepartment.body.data.id}/members`)
      .set(authHeader(token))
      .send({ userIds: [String(first._id), String(occupied._id)] });
    expect(response.status).toBe(409);
    expect((await User.findById(first._id)).organizationMemberships[0].departmentId).toBeNull();
    expect(await AuditLog.countDocuments({ action: 'DEPARTMENT_MEMBER_ADDED' })).toBe(0);
  });

  it('allows only one concurrent department assignment for the same organization membership', async () => {
    const { organizationId, token } = await createOrganizationContext('concurrent');
    const member = await createMember({ email: 'concurrent-member@example.com', organizationId });
    const first = await createDepartment(token, { name: 'Concurrent One' });
    const second = await createDepartment(token, { name: 'Concurrent Two' });

    const responses = await Promise.all([
      request(app)
        .post(`/api/departments/${first.body.data.id}/members`)
        .set(authHeader(token))
        .send({ userIds: [String(member._id)] }),
      request(app)
        .post(`/api/departments/${second.body.data.id}/members`)
        .set(authHeader(token))
        .send({ userIds: [String(member._id)] }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const saved = await User.findById(member._id);
    expect([first.body.data.id, second.body.data.id]).toContain(
      String(saved.organizationMemberships[0].departmentId)
    );
    expect(await AuditLog.countDocuments({ action: 'DEPARTMENT_MEMBER_ADDED' })).toBe(1);
  });

  it('activates and deactivates without clearing manager or member references', async () => {
    const { organizationId, admin, token } = await createOrganizationContext('status');
    const manager = await createMember({ email: 'status-manager@example.com', organizationId });
    const member = await createMember({ email: 'status-member@example.com', organizationId });
    const department = await Department.create({
      organizationId,
      name: 'Existing Department',
      managerIds: [manager._id],
      status: 'ACTIVE',
    });
    member.organizationMemberships[0].departmentId = department._id;
    await member.save();

    const deactivated = await request(app)
      .patch(`/api/departments/${department._id}/deactivate`)
      .set(authHeader(token));
    expect(deactivated.status).toBe(200);
    const saved = await Department.findById(department._id);
    expect(saved.status).toBe('INACTIVE');
    expect(saved.managerIds.map(String)).toEqual([String(manager._id)]);
    expect(String((await User.findById(member._id)).organizationMemberships[0].departmentId)).toBe(String(department._id));

    const blockedAdd = await request(app)
      .post(`/api/departments/${department._id}/members`)
      .set(authHeader(token))
      .send({ userIds: [String(admin._id)] });
    expect(blockedAdd.status).toBe(403);
    expect(blockedAdd.body.code).toBe('DEPARTMENT_INACTIVE');

    const blockedUpdate = await request(app)
      .patch(`/api/departments/${department._id}`)
      .set(authHeader(token))
      .send({ description: 'Should not update while inactive' });
    expect(blockedUpdate.status).toBe(403);
    expect(blockedUpdate.body.code).toBe('DEPARTMENT_INACTIVE');

    const reactivated = await request(app)
      .patch(`/api/departments/${department._id}/activate`)
      .set(authHeader(token));
    expect(reactivated.status).toBe(200);
    expect(reactivated.body.data.status).toBe('ACTIVE');
    expect(await AuditLog.countDocuments({ action: 'DEPARTMENT_DEACTIVATED', resourceId: department._id })).toBe(1);
    expect(await AuditLog.countDocuments({ action: 'DEPARTMENT_ACTIVATED', resourceId: department._id })).toBe(1);
  });

  it('rejects access without an eligible role, for Super Admin, and across organizations', async () => {
    const local = await createOrganizationContext('authorization');
    const foreign = await createOrganizationContext('authorization-foreign');
    const department = await createDepartment(local.token);
    const regular = await createMember({ email: 'regular-department-user@example.com', organizationId: local.organizationId });
    const regularLogin = await loginRequest({ email: regular.email, password: TEST_PASSWORD });
    const superAdmin = await createSuperAdmin({ email: 'department-super-admin@example.com' });
    const superLogin = await loginRequest({ email: superAdmin.email, password: TEST_PASSWORD });

    const forbidden = await request(app)
      .get('/api/departments')
      .set(authHeader(regularLogin.body.data.accessToken));
    expect(forbidden.status).toBe(403);

    const superForbidden = await request(app)
      .get('/api/departments')
      .set(authHeader(superLogin.body.data.accessToken));
    expect(superForbidden.status).toBe(403);

    const foreignAccess = await request(app)
      .patch(`/api/departments/${department.body.data.id}`)
      .set(authHeader(foreign.token))
      .send({ name: 'Hijacked' });
    expect(foreignAccess.status).toBe(404);

    const unauthenticated = await request(app).get('/api/departments');
    expect(unauthenticated.status).toBe(401);
  });

  it('blocks department changes while the parent organization is inactive', async () => {
    const { organizationId, admin, token } = await createOrganizationContext('inactive-parent');
    const department = await createDepartment(token);
    await Organization.updateOne({ _id: organizationId }, { $set: { status: 'INACTIVE' } });

    const response = await request(app)
      .patch(`/api/departments/${department.body.data.id}/deactivate`)
      .set(authHeader(token));
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('ORGANIZATION_INACTIVE');
    expect(await AuditLog.countDocuments({ actorId: admin._id, action: 'DEPARTMENT_DEACTIVATED' })).toBe(0);
  });
});
