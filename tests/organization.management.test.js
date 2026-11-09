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
} from './helpers.js';
import Organization from '../src/models/Organization.js';
import Role from '../src/models/Role.js';
import UserRoleAssignment from '../src/models/UserRoleAssignment.js';
import AuditLog from '../src/models/AuditLog.js';

const authHeader = (token) => ({ Authorization: `Bearer ${token}` });

const loginSuperAdmin = async (email = 'org-super@example.com') => {
  await createSuperAdmin({ email });
  const response = await loginRequest({ email, password: TEST_PASSWORD });
  return {
    accessToken: response.body.data.accessToken,
    response,
  };
};

const createOrgViaApi = async (token, payload = {}) => {
  const body = {
    name: 'Acme Corp',
    admin: {
      name: 'Jane Admin',
      email: 'admin@acme.example',
      password: TEST_PASSWORD,
    },
    ...payload,
  };

  return request(app)
    .post('/api/organizations')
    .set(authHeader(token))
    .send(body);
};

describe('Organization management', () => {
  beforeAll(async () => {
    await connectTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await disconnectTestDatabase();
  });

  it('creates an organization and its first admin together', async () => {
    const { accessToken } = await loginSuperAdmin('org-create@example.com');

    const response = await createOrgViaApi(accessToken, {
      name: 'Acme Corp',
      admin: {
        name: 'Jane Admin',
        email: 'admin@acme.example',
        password: TEST_PASSWORD,
      },
    });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.data.organization.name).toBe('Acme Corp');
    expect(response.body.data.organization.status).toBe('ACTIVE');
    expect(response.body.data.admin.email).toBe('admin@acme.example');
    expect(response.body.data.admin.passwordHash).toBeUndefined();

    const organization = await Organization.findById(response.body.data.organization.id);
    expect(organization.createdBy).toBeTruthy();
    expect(organization.status).toBe('ACTIVE');

    const adminUser = await User.findOne({ email: 'admin@acme.example' });
    expect(adminUser).toBeTruthy();
    expect(adminUser.platformRole).toBeNull();
    expect(adminUser.organizationMemberships).toHaveLength(1);
    expect(String(adminUser.organizationMemberships[0].organizationId)).toBe(
      String(organization._id)
    );
    expect(adminUser.organizationMemberships[0].status).toBe('ACTIVE');

    const role = await Role.findOne({ organizationId: organization._id, name: 'Organization Admin' });
    expect(role).toBeTruthy();
    expect(role.permissions.length).toBeGreaterThan(0);
    const employeeRole = await Role.findOne({ organizationId: organization._id, roleType: 'EMPLOYEE' });
    expect(employeeRole.permissions).toEqual(expect.arrayContaining([
      'requests.create',
      'requests.edit_own_draft',
      'requests.submit',
      'requests.cancel_own',
    ]));

    const assignment = await UserRoleAssignment.findOne({
      userId: adminUser._id,
      organizationId: organization._id,
    });
    expect(assignment).toBeTruthy();
    expect(assignment.scopeType).toBe('ORGANIZATION');
    expect(assignment.departmentId).toBeNull();

    const logs = await AuditLog.find({ organizationId: organization._id }).lean();
    expect(logs.some((entry) => entry.action === 'ORGANIZATION_CREATED')).toBe(true);
    expect(logs.some((entry) => entry.action === 'ORGANIZATION_ADMIN_CREATED')).toBe(true);
  });

  it('rejects unauthenticated or unauthorized organization creation', async () => {
    const unauthenticated = await request(app).post('/api/organizations').send({
      name: 'Blocked Org',
      admin: {
        name: 'Jane Admin',
        email: 'admin@blocked.example',
        password: TEST_PASSWORD,
      },
    });

    expect(unauthenticated.status).toBe(401);

    const organization = await Organization.create({
      name: 'Team Org',
      status: 'ACTIVE',
      createdBy: new mongoose.Types.ObjectId(),
    });

    const regularUser = await createUser({
      email: 'regular@example.com',
      organizationMemberships: [
        {
          membershipId: new mongoose.Types.ObjectId(),
          organizationId: organization._id,
          departmentId: null,
          status: 'ACTIVE',
        },
      ],
    });

    const regularLogin = await loginRequest({
      email: 'regular@example.com',
      password: TEST_PASSWORD,
    });

    const unauthorized = await request(app)
      .post('/api/organizations')
      .set(authHeader(regularLogin.body.data.accessToken))
      .send({
        name: 'Nope',
        admin: {
          name: 'Jane Admin',
          email: 'admin@nope.example',
          password: TEST_PASSWORD,
        },
      });

    expect(unauthorized.status).toBe(403);
  });

  it('rejects malformed admin names before writing any records', async () => {
    const { accessToken } = await loginSuperAdmin('org-validation@example.com');
    const response = await createOrgViaApi(accessToken, {
      name: 'Invalid Admin Org',
      admin: {
        name: 'A'.repeat(201),
        email: 'long-name@org.example',
        password: TEST_PASSWORD,
      },
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(await Organization.countDocuments()).toBe(0);
    expect(await User.countDocuments({ email: 'long-name@org.example' })).toBe(0);
  });

  it('maps duplicate organization and admin emails to conflicts without partial writes', async () => {
    const { accessToken } = await loginSuperAdmin('org-duplicates@example.com');
    const first = await createOrgViaApi(accessToken, {
      name: 'Unique Org',
      admin: { name: 'First Admin', email: 'first@unique.example', password: TEST_PASSWORD },
    });
    expect(first.status).toBe(201);

    const duplicateName = await createOrgViaApi(accessToken, {
      name: 'Unique Org',
      admin: { name: 'Second Admin', email: 'second@unique.example', password: TEST_PASSWORD },
    });
    expect(duplicateName.status).toBe(409);
    expect(duplicateName.body.code).toBe('ORGANIZATION_NAME_EXISTS');

    const duplicateEmail = await createOrgViaApi(accessToken, {
      name: 'Another Org',
      admin: { name: 'Other Admin', email: 'first@unique.example', password: TEST_PASSWORD },
    });
    expect(duplicateEmail.status).toBe(409);
    expect(duplicateEmail.body.code).toBe('EMAIL_EXISTS');
    expect(await Organization.countDocuments()).toBe(1);
    expect(await User.countDocuments()).toBe(2);
  });

  it('lists organizations with pagination and filters', async () => {
    const { accessToken } = await loginSuperAdmin('org-list@example.com');

    await createOrgViaApi(accessToken, { name: 'Alpha Org', admin: { name: 'A Admin', email: 'a@alpha.example', password: TEST_PASSWORD } });
    await createOrgViaApi(accessToken, { name: 'Beta Org', admin: { name: 'B Admin', email: 'b@beta.example', password: TEST_PASSWORD } });

    const response = await request(app)
      .get('/api/organizations?page=1&limit=10&status=ACTIVE&sortBy=createdAt&sortOrder=desc')
      .set(authHeader(accessToken));

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.items).toHaveLength(2);
    expect(response.body.data.pagination.total).toBe(2);
    expect(response.body.data.pagination.page).toBe(1);

    const filteredPage = await request(app)
      .get('/api/organizations?search=Alpha&page=1&limit=1')
      .set(authHeader(accessToken));
    expect(filteredPage.status).toBe(200);
    expect(filteredPage.body.data.items).toHaveLength(1);
    expect(filteredPage.body.data.items[0].name).toBe('Alpha Org');
    expect(filteredPage.body.data.pagination.totalPages).toBe(1);

    const repeatedSearch = await request(app)
      .get('/api/organizations?search=Alpha&search=Beta')
      .set(authHeader(accessToken));
    expect(repeatedSearch.status).toBe(400);
    expect(repeatedSearch.body.code).toBe('VALIDATION_ERROR');
  });

  it('updates organization names and toggles activation', async () => {
    const { accessToken } = await loginSuperAdmin('org-update@example.com');
    const created = await createOrgViaApi(accessToken, { name: 'Legacy Org', admin: { name: 'Old Admin', email: 'old@legacy.example', password: TEST_PASSWORD } });

    const orgId = created.body.data.organization.id;

    const second = await createOrgViaApi(accessToken, {
      name: 'Existing Org',
      admin: { name: 'Second Admin', email: 'second@existing.example', password: TEST_PASSWORD },
    });
    expect(second.status).toBe(201);

    const duplicateName = await request(app)
      .patch(`/api/organizations/${orgId}`)
      .set(authHeader(accessToken))
      .send({ name: 'Existing Org' });
    expect(duplicateName.status).toBe(409);
    expect(duplicateName.body.code).toBe('ORGANIZATION_NAME_EXISTS');

    const updateResponse = await request(app)
      .patch(`/api/organizations/${orgId}`)
      .set(authHeader(accessToken))
      .send({ name: 'Updated Org' });

    expect(updateResponse.status).toBe(200);
    expect(updateResponse.body.data.name).toBe('Updated Org');

    const deactivateResponse = await request(app)
      .patch(`/api/organizations/${orgId}/deactivate`)
      .set(authHeader(accessToken));
    expect(deactivateResponse.status).toBe(200);
    expect(deactivateResponse.body.data.status).toBe('INACTIVE');

    const activateResponse = await request(app)
      .patch(`/api/organizations/${orgId}/activate`)
      .set(authHeader(accessToken));
    expect(activateResponse.status).toBe(200);
    expect(activateResponse.body.data.status).toBe('ACTIVE');

    const org = await Organization.findById(orgId);
    expect(org.status).toBe('ACTIVE');

    const organizationLogs = await AuditLog.find({ organizationId: orgId }).lean();
    expect(organizationLogs.some((entry) => entry.action === 'ORGANIZATION_UPDATED')).toBe(true);
    expect(organizationLogs.some((entry) => entry.action === 'ORGANIZATION_DEACTIVATED')).toBe(true);
    expect(organizationLogs.some((entry) => entry.action === 'ORGANIZATION_ACTIVATED')).toBe(true);
  });

  it('blocks organization members from logging in while their organization is inactive', async () => {
    const { accessToken } = await loginSuperAdmin('org-inactive-login@example.com');
    const created = await createOrgViaApi(accessToken, {
      name: 'Inactive Login Org',
      admin: { name: 'Org Admin', email: 'inactive-admin@org.example', password: TEST_PASSWORD },
    });
    const organizationId = created.body.data.organization.id;

    await request(app)
      .patch(`/api/organizations/${organizationId}/deactivate`)
      .set(authHeader(accessToken));

    const login = await loginRequest({
      email: 'inactive-admin@org.example',
      password: TEST_PASSWORD,
    });
    expect(login.status).toBe(403);
    expect(login.body.code).toBe('ORGANIZATION_INACTIVE');
  });

  it('returns organization details with member counts', async () => {
    const { accessToken } = await loginSuperAdmin('org-detail@example.com');
    const created = await createOrgViaApi(accessToken, { name: 'Detail Org', admin: { name: 'Detail Admin', email: 'detail@org.example', password: TEST_PASSWORD } });

    const organizationId = created.body.data.organization.id;
    const user = await User.create({
      name: 'Member User',
      email: 'member@org.example',
      passwordHash: 'hash',
      platformRole: null,
      organizationMemberships: [{ membershipId: '507f1f77bcf86cd799439011', organizationId, departmentId: null, status: 'ACTIVE' }],
    });

    const response = await request(app)
      .get(`/api/organizations/${organizationId}`)
      .set(authHeader(accessToken));

    expect(response.status).toBe(200);
    expect(response.body.data.summary.memberCount).toBeGreaterThanOrEqual(2);
  });
 });
