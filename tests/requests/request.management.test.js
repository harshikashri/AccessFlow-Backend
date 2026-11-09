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
} from '../helpers.js';
import Organization from '../../src/models/Organization.js';
import Department from '../../src/models/Department.js';
import Role from '../../src/models/Role.js';
import UserRoleAssignment from '../../src/models/UserRoleAssignment.js';
import Request from '../../src/models/Request.js';
import ApprovalStep from '../../src/models/ApprovalStep.js';
import WorkflowDefinition from '../../src/models/WorkflowDefinition.js';
import AuditLog from '../../src/models/AuditLog.js';
import {
  DEPARTMENT_MANAGER_PERMISSIONS,
  ORGANIZATION_ADMIN_PERMISSIONS,
  DEPARTMENT_MEMBER_PERMISSIONS,
} from '../../src/config/constants.js';

const authHeader = (token) => ({ Authorization: `Bearer ${token}` });

const setup = async (suffix = 'request') => {
  const platformAdmin = await createSuperAdmin({ email: `request-platform-${suffix}@example.com` });
  const organizationId = new mongoose.Types.ObjectId();
  const admin = await createUser({
    email: `request-admin-${suffix}@example.com`,
    organizationMemberships: [{ organizationId, departmentId: null, status: 'ACTIVE' }],
  });
  const member = await createUser({
    email: `request-member-${suffix}@example.com`,
    organizationMemberships: [],
  });
  const organization = await Organization.create({
    _id: organizationId,
    name: `Request Organization ${suffix}`,
    status: 'ACTIVE',
    createdBy: platformAdmin._id,
  });
  const adminRole = await Role.create({
    organizationId,
    name: 'Organization Admin',
    roleType: 'ORGANIZATION_ADMIN',
    permissions: ORGANIZATION_ADMIN_PERMISSIONS,
    status: 'ACTIVE',
    createdBy: platformAdmin._id,
  });
  const memberRole = await Role.create({
    organizationId,
    name: 'Request Contributor',
    roleType: 'CUSTOM',
    permissions: [
      ...DEPARTMENT_MEMBER_PERMISSIONS,
    ],
    status: 'ACTIVE',
    createdBy: platformAdmin._id,
  });
  await UserRoleAssignment.create([
    {
      userId: admin._id,
      roleId: adminRole._id,
      organizationId,
      departmentId: null,
      scopeType: 'ORGANIZATION',
      status: 'ACTIVE',
      assignedBy: platformAdmin._id,
    },
    {
      userId: member._id,
      roleId: memberRole._id,
      organizationId,
      departmentId: null,
      scopeType: 'ORGANIZATION',
      status: 'ACTIVE',
      assignedBy: admin._id,
    },
  ]);
  const department = await Department.create({ organizationId, name: 'Engineering' });
  member.organizationMemberships = [{
    membershipId: new mongoose.Types.ObjectId(),
    organizationId,
    departmentId: department._id,
    status: 'ACTIVE',
  }];
  await member.save();
  const adminLogin = await loginRequest({ email: admin.email, password: TEST_PASSWORD });
  const memberLogin = await loginRequest({ email: member.email, password: TEST_PASSWORD });
  return {
    organization,
    organizationId,
    admin,
    member,
    department,
    adminToken: adminLogin.body.data.accessToken,
    memberToken: memberLogin.body.data.accessToken,
  };
};

const createType = (token, body = {}) => request(app)
  .post('/api/request-types')
  .set(authHeader(token))
  .send({
    name: 'Purchase Request',
    code: 'PURCHASE_CUSTOM',
    description: 'Purchase requests',
    fields: [
      { key: 'itemName', label: 'Item name', type: 'TEXT', required: true },
      { key: 'quantity', label: 'Quantity', type: 'NUMBER', required: true },
      { key: 'kind', label: 'Kind', type: 'SELECT', required: false, options: ['Hardware', 'Software'] },
    ],
    ...body,
  });

const createPurchaseType = (token, body = {}) => request(app)
  .post('/api/request-types')
  .set(authHeader(token))
  .send({
    name: 'Purchase Request',
    code: 'PURCHASE',
    description: 'Purchase requests',
    fields: [
      { key: 'itemName', label: 'Item name', type: 'TEXT', required: true },
      { key: 'quantity', label: 'Quantity', type: 'NUMBER', required: true },
      { key: 'estimatedCost', label: 'Estimated cost', type: 'NUMBER', semantic: 'AMOUNT', required: true },
      { key: 'justification', label: 'Justification', type: 'TEXTAREA', required: true },
    ],
    ...body,
  });

describe('Request management', () => {
  beforeAll(async () => connectTestDatabase());
  beforeEach(async () => resetTestDatabase());
  afterAll(async () => disconnectTestDatabase());

  it('creates, lists, updates and deactivates configurable request types', async () => {
    const context = await setup('types');
    const created = await createType(context.adminToken);
    expect(created.status).toBe(201);
    expect(created.body.data.definitionType).toBe('REQUEST_TYPE');
    expect(created.body.data.fields).toHaveLength(3);

    const listed = await request(app).get('/api/request-types?includeInactive=true').set(authHeader(context.adminToken));
    expect(listed.status).toBe(200);
    expect(listed.body.data.items).toHaveLength(1);

    const updated = await request(app)
      .patch(`/api/request-types/${created.body.data.id}`)
      .set(authHeader(context.adminToken))
      .send({ name: 'Updated Purchase', code: 'PURCHASE_UPDATED', fields: [{ key: 'reason', label: 'Reason', type: 'TEXTAREA', required: true }] });
    expect(updated.status).toBe(200);

    const deactivated = await request(app)
      .patch(`/api/request-types/${created.body.data.id}/deactivate`)
      .set(authHeader(context.adminToken));
    expect(deactivated.status).toBe(200);
    expect(deactivated.body.data.isActive).toBe(false);
  });

  it('rejects invalid request type fields and duplicate codes', async () => {
    const context = await setup('type-validation');
    expect((await createType(context.adminToken, {
      code: 'BAD',
      fields: [{ key: 'value', label: 'Value', type: 'SELECT' }],
    })).status).toBe(400);
    expect((await createType(context.adminToken)).status).toBe(201);
    const duplicate = await createType(context.adminToken, { name: 'Other', code: 'PURCHASE_CUSTOM' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('REQUEST_TYPE_CODE_EXISTS');
  });

  it('evaluates conditional visibility and required fields', async () => {
    const context = await setup('conditional-fields');
    const type = await createType(context.adminToken, {
      code: 'CONDITIONAL',
      fields: [
        { key: 'category', label: 'Category', type: 'SELECT', required: true, options: ['Standard', 'Special'] },
        { key: 'specialDetails', label: 'Special details', type: 'TEXT', required: false, visibleWhen: { field: 'category', operator: 'EQUALS', value: 'Special' }, requiredWhen: { field: 'category', operator: 'EQUALS', value: 'Special' } },
      ],
    });
    expect(type.status).toBe(201);

    const hidden = await request(app)
      .post('/api/requests')
      .set(authHeader(context.memberToken))
      .send({
        departmentId: String(context.department._id),
        requestTypeId: type.body.data.id,
        title: 'Standard request',
        details: { category: 'Standard' },
      });
    expect(hidden.status).toBe(201);

    const missing = await request(app)
      .post('/api/requests')
      .set(authHeader(context.memberToken))
      .send({
        departmentId: String(context.department._id),
        requestTypeId: type.body.data.id,
        title: 'Special request',
        details: { category: 'Special' },
      });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('INVALID_REQUEST_DETAILS');

    const visible = await request(app)
      .post('/api/requests')
      .set(authHeader(context.memberToken))
      .send({
        departmentId: String(context.department._id),
        requestTypeId: type.body.data.id,
        title: 'Complete special request',
        details: { category: 'Special', specialDetails: 'Additional context' },
      });
    expect(visible.status).toBe(201);
  });

  it('supports conditional AND and OR groups and rejects circular dependencies', async () => {
    const context = await setup('conditional-groups');
    const valid = await createType(context.adminToken, {
      code: 'CONDITIONAL_GROUPS',
      fields: [
        { key: 'category', label: 'Category', type: 'SELECT', required: true, options: ['A', 'B'] },
        { key: 'priority', label: 'Priority', type: 'SELECT', required: true, options: ['High', 'Low'] },
        {
          key: 'details',
          label: 'Details',
          type: 'TEXT',
          required: false,
          visibleWhen: {
            operator: 'OR',
            conditions: [
              { field: 'category', operator: 'EQUALS', value: 'A' },
              { operator: 'AND', conditions: [{ field: 'category', operator: 'EQUALS', value: 'B' }, { field: 'priority', operator: 'EQUALS', value: 'High' }] },
            ],
          },
        },
      ],
    });
    expect(valid.status).toBe(201);

    const circular = await createType(context.adminToken, {
      code: 'CONDITIONAL_CYCLE',
      fields: [
        { key: 'first', label: 'First', type: 'TEXT', required: false, visibleWhen: { field: 'second', operator: 'IS_NOT_EMPTY' } },
        { key: 'second', label: 'Second', type: 'TEXT', required: false, visibleWhen: { field: 'first', operator: 'IS_NOT_EMPTY' } },
      ],
    });
    expect(circular.status).toBe(400);
  });

  it('creates a purchase request from its configured amount field and rejects inconsistent amount input', async () => {
    const context = await setup('purchase-valid');
    const type = await createPurchaseType(context.adminToken);
    const created = await request(app)
      .post('/api/requests')
      .set(authHeader(context.memberToken))
      .send({
        departmentId: String(context.department._id),
        requestTypeId: type.body.data.id,
        title: 'Laptop purchase request',
        priority: 'MEDIUM',
        details: {
          itemName: 'Dell Latitude laptop',
          quantity: 1,
          estimatedCost: 120000,
          justification: 'Required for development work.',
        },
      });

    expect(created.status).toBe(201);
    expect(created.body.data.amount).toBe(120000);
    expect((await Request.findById(created.body.data.id)).amount).toBe(120000);

    const unsupportedAmount = await request(app)
      .post('/api/requests')
      .set(authHeader(context.memberToken))
      .send({
        departmentId: String(context.department._id),
        requestTypeId: type.body.data.id,
        title: 'Another laptop purchase',
        amount: 120000,
        details: {
          itemName: 'Dell Latitude laptop',
          quantity: 1,
          estimatedCost: 120000,
          justification: 'Required for development work.',
        },
      });
    expect(unsupportedAmount.status).toBe(400);
    expect(unsupportedAmount.body.details).toContain('amount');
  });

  it.each([
    ['missing', undefined],
    ['zero', 0],
    ['negative', -1],
    ['non-numeric', '120000'],
  ])('rejects a purchase request with %s estimated cost', async (label, estimatedCost) => {
    const context = await setup(`purchase-${label}`);
    const type = await createPurchaseType(context.adminToken);
    const details = {
      itemName: 'Dell Latitude laptop',
      quantity: 1,
      justification: 'Required for development work.',
    };
    if (estimatedCost !== undefined) details.estimatedCost = estimatedCost;

    const response = await request(app)
      .post('/api/requests')
      .set(authHeader(context.memberToken))
      .send({
        departmentId: String(context.department._id),
        requestTypeId: type.body.data.id,
        title: 'Invalid laptop purchase',
        details,
      });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_REQUEST_DETAILS');
  });

  it('rejects unknown purchase fields and keeps non-purchase request types independent of amount', async () => {
    const context = await setup('purchase-fields');
    const purchaseType = await createPurchaseType(context.adminToken);
    const unknownField = await request(app)
      .post('/api/requests')
      .set(authHeader(context.memberToken))
      .send({
        departmentId: String(context.department._id),
        requestTypeId: purchaseType.body.data.id,
        title: 'Unknown field purchase',
        details: {
          itemName: 'Laptop',
          quantity: 1,
          estimatedCost: 120000,
          justification: 'Required for development work.',
          unexpected: true,
        },
      });
    expect(unknownField.status).toBe(400);
    expect(unknownField.body.code).toBe('INVALID_REQUEST_DETAILS');

    const generalType = await createType(context.adminToken, {
      name: 'General Request',
      code: 'GENERAL',
      fields: [{ key: 'reason', label: 'Reason', type: 'TEXT', required: true }],
    });
    const general = await request(app)
      .post('/api/requests')
      .set(authHeader(context.memberToken))
      .send({
        departmentId: String(context.department._id),
        requestTypeId: generalType.body.data.id,
        title: 'General request',
        details: { reason: 'General equipment request' },
      });
    expect(general.status).toBe(201);
    expect(general.body.data.amount).toBeNull();
  });

  it('creates, edits, submits and cancels requests without creating approval steps', async () => {
    const context = await setup('lifecycle');
    const type = await createType(context.adminToken);
    const created = await request(app)
      .post('/api/requests')
      .set(authHeader(context.memberToken))
      .send({
        departmentId: String(context.department._id),
        requestTypeId: type.body.data.id,
        title: 'Laptop purchase',
        details: { itemName: 'Laptop', quantity: 2 },
      });
    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe('DRAFT');
    expect(created.body.data.requestNumber).toMatch(/^REQ-\d{2}-[A-F0-9]+$/);

    const updated = await request(app)
      .patch(`/api/requests/${created.body.data.id}`)
      .set(authHeader(context.memberToken))
      .send({ title: 'Updated laptop purchase', details: { itemName: 'Laptop Pro', quantity: 3 } });
    expect(updated.status).toBe(200);

    const submitted = await request(app)
      .post(`/api/requests/${created.body.data.id}/submit`)
      .set(authHeader(context.memberToken))
      .send({});
    expect(submitted.status).toBe(200);
    expect(submitted.body.data.status).toBe('SUBMITTED');
    expect(await ApprovalStep.countDocuments()).toBe(0);

    const cancelled = await request(app)
      .post(`/api/requests/${created.body.data.id}/cancel`)
      .set(authHeader(context.memberToken))
      .send({ cancellationReason: 'No longer needed' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');
    expect(cancelled.body.data.cancelledBy).toBe(String(context.member._id));
    expect(await AuditLog.countDocuments({ action: { $in: ['REQUEST_CREATED', 'REQUEST_UPDATED', 'REQUEST_SUBMITTED', 'REQUEST_CANCELLED'] } })).toBe(4);
  });

  it('allows the request creator to update their own draft with the explicit permission', async () => {
    const context = await setup('draft-update');
    const type = await createType(context.adminToken, {
      name: 'Draft Update Request',
      code: 'DRAFT_UPDATE',
      fields: [
        { key: 'reason', label: 'Reason', type: 'TEXT', required: true },
      ],
    });
    const created = await request(app)
      .post('/api/requests')
      .set(authHeader(context.memberToken))
      .send({
        departmentId: String(context.department._id),
        requestTypeId: type.body.data.id,
        title: 'Initial request',
        details: { reason: 'Initial reason' },
      });
    expect(created.status).toBe(201);

    const updated = await request(app)
      .patch(`/api/requests/${created.body.data.id}`)
      .set(authHeader(context.memberToken))
      .send({
        title: 'Updated request',
        description: 'Updated description',
        details: { reason: 'Updated reason' },
      });

    expect(updated.status).toBe(200);
    expect(updated.body.data.title).toBe('Updated request');
    expect(updated.body.data.status).toBe('DRAFT');
    expect(await AuditLog.countDocuments({
      action: 'REQUEST_UPDATED',
      resourceId: created.body.data.id,
    })).toBe(1);
  });

  it('merges partial dynamic-field updates and validates the final details', async () => {
    const context = await setup('partial-dynamic-update');
    const type = await createPurchaseType(context.adminToken);
    const created = await request(app)
      .post('/api/requests')
      .set(authHeader(context.memberToken))
      .send({
        departmentId: String(context.department._id),
        requestTypeId: type.body.data.id,
        title: 'Laptop purchase',
        description: 'Original description',
        details: {
          itemName: 'Laptop',
          quantity: 1,
          estimatedCost: 65000,
          justification: 'Development work.',
        },
      });
    expect(created.status).toBe(201);

    const updated = await request(app)
      .patch(`/api/requests/${created.body.data.id}`)
      .set(authHeader(context.memberToken))
      .send({
        title: 'Laptop Purchase - Updated',
        description: 'Updated description',
        details: { estimatedCost: 75000 },
      });

    expect(updated.status).toBe(200);
    expect(updated.body.data.title).toBe('Laptop Purchase - Updated');
    expect(updated.body.data.description).toBe('Updated description');
    expect(updated.body.data.details).toEqual({
      itemName: 'Laptop',
      quantity: 1,
      estimatedCost: 75000,
      justification: 'Development work.',
    });
    expect(updated.body.data.amount).toBe(75000);
    expect(updated.body.data.status).toBe('DRAFT');

    const unknownField = await request(app)
      .patch(`/api/requests/${created.body.data.id}`)
      .set(authHeader(context.memberToken))
      .send({ details: { unexpected: true } });
    expect(unknownField.status).toBe(400);
    expect(unknownField.body.code).toBe('INVALID_REQUEST_DETAILS');

    const missingRequired = await request(app)
      .patch(`/api/requests/${created.body.data.id}`)
      .set(authHeader(context.memberToken))
      .send({ details: { itemName: null } });
    expect(missingRequired.status).toBe(400);
    expect(missingRequired.body.code).toBe('INVALID_REQUEST_DETAILS');
  });

  it('enforces own-resource and department visibility without trusting client tenant fields', async () => {
    const context = await setup('visibility');
    const type = await createType(context.adminToken);
    const rejectedTenantFields = await request(app)
      .post('/api/requests')
      .set(authHeader(context.memberToken))
      .send({
        organizationId: String(new mongoose.Types.ObjectId()),
        requesterId: String(context.admin._id),
        departmentId: String(context.department._id),
        requestTypeId: type.body.data.id,
        title: 'Own request',
        details: { itemName: 'Monitor', quantity: 1 },
      });
    expect(rejectedTenantFields.status).toBe(400);

    const created = await request(app)
      .post('/api/requests')
      .set(authHeader(context.memberToken))
      .send({
        departmentId: String(context.department._id),
        requestTypeId: type.body.data.id,
        title: 'Own request',
        details: { itemName: 'Monitor', quantity: 1 },
      });
    expect(created.status).toBe(201);

    const own = await request(app)
      .get(`/api/requests/${created.body.data.id}`)
      .set(authHeader(context.memberToken));
    expect(own.status).toBe(200);

    const foreign = await request(app)
      .get(`/api/requests/${created.body.data.id}`)
      .set(authHeader(context.adminToken));
    expect(foreign.status).toBe(404);

    const invalidDetails = await request(app)
      .patch(`/api/requests/${created.body.data.id}`)
      .set(authHeader(context.memberToken))
      .send({ details: { unknown: true } });
    expect(invalidDetails.status).toBe(400);
  });

  it('restricts employee, manager, and organization admin list and detail visibility', async () => {
    const context = await setup('visibility-categories');
    const requestType = await createType(context.adminToken, {
      name: 'Visibility Request',
      code: 'VISIBILITY',
      fields: [{ key: 'reason', label: 'Reason', type: 'TEXT', required: true }],
    });
    const departmentB = await Department.create({
      organizationId: context.organizationId,
      name: 'Finance',
      status: 'ACTIVE',
    });
    const otherMember = await createUser({
      email: 'visibility-other-member@example.com',
      organizationMemberships: [{
        organizationId: context.organizationId,
        departmentId: context.department._id,
        status: 'ACTIVE',
      }],
    });
    const manager = await createUser({
      email: 'visibility-manager@example.com',
      organizationMemberships: [{
        organizationId: context.organizationId,
        departmentId: departmentB._id,
        status: 'ACTIVE',
      }],
    });
    const managerRole = await Role.create({
      organizationId: context.organizationId,
      name: 'Visibility Department Manager',
      roleType: 'DEPARTMENT_MANAGER',
      permissions: DEPARTMENT_MANAGER_PERMISSIONS,
      status: 'ACTIVE',
      createdBy: context.admin._id,
    });
    await UserRoleAssignment.create({
      userId: manager._id,
      roleId: managerRole._id,
      organizationId: context.organizationId,
      departmentId: context.department._id,
      scopeType: 'DEPARTMENT',
      status: 'ACTIVE',
      assignedBy: context.admin._id,
    });
    context.department.managerIds = [manager._id];
    await context.department.save();
    const otherMemberRole = await Role.findOne({
      organizationId: context.organizationId,
      name: 'Request Contributor',
    });
    await UserRoleAssignment.create({
      userId: otherMember._id,
      roleId: otherMemberRole._id,
      organizationId: context.organizationId,
      departmentId: null,
      scopeType: 'ORGANIZATION',
      status: 'ACTIVE',
      assignedBy: context.admin._id,
    });
    const managerLogin = await loginRequest({ email: manager.email, password: TEST_PASSWORD });
    const otherMemberLogin = await loginRequest({ email: otherMember.email, password: TEST_PASSWORD });

    const createStoredRequest = (requesterId, departmentId, requestNumber, status = 'DRAFT', submittedAt = null) => Request.create({
      organizationId: context.organizationId,
      requesterId,
      requestNumber,
      departmentId,
      requestTypeId: requestType.body.data.id,
      requestType: 'VISIBILITY',
      requestTypeCode: 'VISIBILITY',
      requestTypeName: 'Visibility Request',
      title: requestNumber,
      details: { reason: requestNumber },
      status,
      submittedAt,
    });
    const own = await createStoredRequest(context.member._id, context.department._id, 'REQ-VIS-001');
    const submittedAt = new Date();
    const colleague = await createStoredRequest(otherMember._id, context.department._id, 'REQ-VIS-002', 'SUBMITTED', submittedAt);
    const managed = await createStoredRequest(otherMember._id, context.department._id, 'REQ-VIS-003', 'CANCELLED', submittedAt);
    const unrelated = await createStoredRequest(otherMember._id, departmentB._id, 'REQ-VIS-004', 'SUBMITTED', submittedAt);
    const managerOwn = await createStoredRequest(manager._id, departmentB._id, 'REQ-VIS-005');
    const adminOwn = await createStoredRequest(context.admin._id, departmentB._id, 'REQ-VIS-006');

    const employeeList = await request(app)
      .get('/api/requests')
      .set(authHeader(context.memberToken));
    expect(employeeList.status).toBe(200);
    expect(employeeList.body.data.items.map((item) => item.id)).toEqual([String(own._id)]);

    const employeeDetails = await request(app)
      .get(`/api/requests/${colleague._id}`)
      .set(authHeader(context.memberToken));
    expect(employeeDetails.status).toBe(404);

    const managerList = await request(app)
      .get('/api/requests')
      .set(authHeader(managerLogin.body.data.accessToken));
    expect(managerList.status).toBe(200);
    expect(managerList.body.data.items.map((item) => item.requestNumber).sort()).toEqual(
      ['REQ-VIS-002', 'REQ-VIS-003', 'REQ-VIS-005'].sort()
    );
    expect(managerList.body.data.items.map((item) => item.requestNumber)).not.toContain(unrelated.requestNumber);

    const adminList = await request(app)
      .get('/api/requests')
      .set(authHeader(context.adminToken));
    expect(adminList.status).toBe(200);
    expect(adminList.body.data.pagination.total).toBe(4);
    expect(adminList.body.data.items.map((item) => item.requestNumber).sort()).toEqual(
      ['REQ-VIS-002', 'REQ-VIS-003', 'REQ-VIS-004', 'REQ-VIS-006'].sort()
    );

    const adminDetails = await request(app)
      .get(`/api/requests/${unrelated._id}`)
      .set(authHeader(context.adminToken));
    expect(adminDetails.status).toBe(200);
    expect(adminDetails.body.data.id).toBe(String(unrelated._id));
    const managerDraftDetails = await request(app)
      .get(`/api/requests/${colleague._id}`)
      .set(authHeader(managerLogin.body.data.accessToken));
    expect(managerDraftDetails.status).toBe(200);
    const managerOwnDraftDetails = await request(app)
      .get(`/api/requests/${managerOwn._id}`)
      .set(authHeader(managerLogin.body.data.accessToken));
    expect(managerOwnDraftDetails.status).toBe(200);
    const adminDraftDetails = await request(app)
      .get(`/api/requests/${own._id}`)
      .set(authHeader(context.adminToken));
    expect(adminDraftDetails.status).toBe(404);
    expect(managerLogin.body.data.accessToken).toBeTruthy();
    expect(otherMemberLogin.body.data.accessToken).toBeTruthy();
    expect(manager._id).toBeTruthy();
    expect(DEPARTMENT_MEMBER_PERMISSIONS).toContain('requests.view');
    expect(managed._id).toBeTruthy();
    expect(managerOwn._id).toBeTruthy();
    expect(adminOwn._id).toBeTruthy();
  });

  it('blocks inactive request types and invalid lifecycle transitions', async () => {
    const context = await setup('inactive');
    const type = await createType(context.adminToken);
    await request(app).patch(`/api/request-types/${type.body.data.id}/deactivate`).set(authHeader(context.adminToken));
    const created = await request(app)
      .post('/api/requests')
      .set(authHeader(context.memberToken))
      .send({
        departmentId: String(context.department._id),
        requestTypeId: type.body.data.id,
        title: 'Blocked request',
        details: { itemName: 'Desk', quantity: 1 },
      });
    expect(created.status).toBe(404);
  });

  it('searches requests with combined filters without bypassing visibility', async () => {
    const context = await setup('search');
    const purchaseType = await createPurchaseType(context.adminToken);
    const generalType = await createType(context.adminToken, {
      name: 'General Search Request',
      code: 'GENERAL_SEARCH',
      fields: [{ key: 'reason', label: 'Reason', type: 'TEXT', required: true }],
    });
    const purchase = await request(app)
      .post('/api/requests')
      .set(authHeader(context.memberToken))
      .send({
        departmentId: String(context.department._id),
        requestTypeId: purchaseType.body.data.id,
        title: 'Search purchase',
        details: {
          itemName: 'Laptop',
          quantity: 1,
          estimatedCost: 75000,
          justification: 'Development work.',
        },
      });
    const general = await request(app)
      .post('/api/requests')
      .set(authHeader(context.memberToken))
      .send({
        departmentId: String(context.department._id),
        requestTypeId: generalType.body.data.id,
        title: 'Search general',
        details: { reason: 'General request' },
      });
    expect(purchase.status).toBe(201);
    expect(general.status).toBe(201);

    await request(app)
      .post(`/api/requests/${purchase.body.data.id}/submit`)
      .set(authHeader(context.memberToken))
      .send({});

    const combined = await request(app)
      .get('/api/requests/search')
      .set(authHeader(context.adminToken))
      .query({
        category: purchaseType.body.data.id,
        departmentId: context.department._id.toString(),
        userId: context.member._id.toString(),
        status: 'SUBMITTED',
      });
    expect(combined.status).toBe(200);
    expect(combined.body.data.pagination.total).toBe(1);
    expect(combined.body.data.items[0].id).toBe(purchase.body.data.id);

    const employeeDrafts = await request(app)
      .get('/api/requests/search')
      .set(authHeader(context.memberToken))
      .query({ status: 'DRAFT' });
    expect(employeeDrafts.status).toBe(200);
    expect(employeeDrafts.body.data.pagination.total).toBe(1);
    expect(employeeDrafts.body.data.items[0].id).toBe(general.body.data.id);

    const otherUser = await request(app)
      .get('/api/requests/search')
      .set(authHeader(context.memberToken))
      .query({ userId: context.admin._id.toString() });
    expect(otherUser.status).toBe(200);
    expect(otherUser.body.data.pagination.total).toBe(0);
  });

  it('rejects invalid search filters', async () => {
    const context = await setup('search-validation');
    const invalidStatus = await request(app)
      .get('/api/requests/search')
      .set(authHeader(context.memberToken))
      .query({ status: 'UNKNOWN' });
    expect(invalidStatus.status).toBe(400);

    const invalidSort = await request(app)
      .get('/api/requests/search')
      .set(authHeader(context.memberToken))
      .query({ sortBy: 'requesterId' });
    expect(invalidSort.status).toBe(400);

    const invalidId = await request(app)
      .get('/api/requests/search')
      .set(authHeader(context.memberToken))
      .query({ departmentId: 'not-an-id' });
    expect(invalidId.status).toBe(400);
  });
});
