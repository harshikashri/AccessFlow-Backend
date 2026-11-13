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
import User from '../../src/models/User.js';
import UserRoleAssignment from '../../src/models/UserRoleAssignment.js';
import Request from '../../src/models/Request.js';
import ApprovalStep from '../../src/models/ApprovalStep.js';
import WorkflowDefinition from '../../src/models/WorkflowDefinition.js';
import AuditLog from '../../src/models/AuditLog.js';
import { initializeDefaultApprovalWorkflow } from '../../src/modules/requests/approvalWorkflow.service.js';
import { withTransaction } from '../../src/utils/transaction.js';
import { processApprovalMaintenance } from '../../src/modules/requests/approvalMaintenance.service.js';
import { migratePurchaseAmountSemantic } from '../../src/modules/requests/requestType.migrations.js';
import { resolveEffectivePermissions } from '../../src/services/authorization/permission.service.js';
import { evaluateCondition } from '../../src/modules/requests/request.conditions.js';
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
  const manager = await createUser({
    email: `request-manager-${suffix}@example.com`,
    organizationMemberships: [],
  });
  const financeApprover = await createUser({
    email: `request-finance-${suffix}@example.com`,
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
  const managerRole = await Role.create({
    organizationId,
    name: 'Department Manager',
    roleType: 'DEPARTMENT_MANAGER',
    permissions: DEPARTMENT_MANAGER_PERMISSIONS,
    status: 'ACTIVE',
    createdBy: platformAdmin._id,
  });
  manager.organizationMemberships = [{
    membershipId: new mongoose.Types.ObjectId(),
    organizationId,
    departmentId: department._id,
    status: 'ACTIVE',
  }];
  await manager.save();
  financeApprover.organizationMemberships = [{
    membershipId: new mongoose.Types.ObjectId(),
    organizationId,
    departmentId: null,
    status: 'ACTIVE',
  }];
  await financeApprover.save();
  await UserRoleAssignment.create({
    userId: manager._id,
    roleId: managerRole._id,
    organizationId,
    departmentId: department._id,
    scopeType: 'DEPARTMENT',
    status: 'ACTIVE',
    assignedBy: admin._id,
  });
  department.managerIds = [manager._id];
  await department.save();
  await withTransaction((session) => initializeDefaultApprovalWorkflow({
    session,
    organizationId,
    actorId: admin._id,
  }));
  const financeRole = await Role.findOne({
    organizationId,
    roleType: 'FINANCE_APPROVER',
    status: 'ACTIVE',
  });
  await UserRoleAssignment.create({
    userId: financeApprover._id,
    roleId: financeRole._id,
    organizationId,
    departmentId: null,
    scopeType: 'ORGANIZATION',
    status: 'ACTIVE',
    assignedBy: admin._id,
  });
  member.organizationMemberships = [{
    membershipId: new mongoose.Types.ObjectId(),
    organizationId,
    departmentId: department._id,
    status: 'ACTIVE',
  }];
  await member.save();
  const adminLogin = await loginRequest({ email: admin.email, password: TEST_PASSWORD });
  const memberLogin = await loginRequest({ email: member.email, password: TEST_PASSWORD });
  const managerLogin = await loginRequest({ email: manager.email, password: TEST_PASSWORD });
  const financeLogin = await loginRequest({ email: financeApprover.email, password: TEST_PASSWORD });
  return {
    organization,
    organizationId,
    admin,
    member,
    manager,
    department,
    adminToken: adminLogin.body.data.accessToken,
    memberToken: memberLogin.body.data.accessToken,
    managerToken: managerLogin.body.data.accessToken,
    financeToken: financeLogin.body.data.accessToken,
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

  it('initializes the default approval workflow idempotently and allows admins to customize it', async () => {
    const context = await setup('default-workflow-migration');
    let workflow = await WorkflowDefinition.findOne({
      organizationId: context.organizationId,
      definitionType: 'APPROVAL_WORKFLOW',
      isDefault: true,
      isActive: true,
    });
    expect(workflow).toBeTruthy();
    expect(workflow.stages).toHaveLength(2);
    expect(workflow.stages[0]).toMatchObject({
      sequence: 1,
      approverType: 'DEPARTMENT_MANAGER',
      assignment: { type: 'DEPARTMENT_MANAGER', resolution: 'CLAIM_ONE' },
      isMandatory: true,
      condition: null,
    });
    const financeRole = await Role.findOne({
      _id: workflow.stages[1].assignment.roleId,
      organizationId: context.organizationId,
      roleType: 'FINANCE_APPROVER',
      status: 'ACTIVE',
    });
    expect(financeRole).toBeTruthy();

    await WorkflowDefinition.deleteOne({ _id: workflow._id });
    financeRole.roleType = 'CUSTOM';
    await financeRole.save();
    const initialized = await withTransaction((session) => initializeDefaultApprovalWorkflow({
      session,
      organizationId: context.organizationId,
      actorId: context.admin._id,
    }));
    workflow = await WorkflowDefinition.findById(initialized._id);
    expect(String(workflow.stages[1].assignment.roleId)).toBe(String(financeRole._id));
    expect(await Role.countDocuments({ organizationId: context.organizationId, nameNormalized: 'finance approver' })).toBe(1);
    expect((await Role.findById(financeRole._id)).permissions).toEqual(['requests.approve']);

    expect(workflow.stages[1]).toMatchObject({
      sequence: 2,
      approverType: 'ROLE',
      assignment: { type: 'ROLE', resolution: 'CLAIM_ONE' },
      condition: { field: 'amount', operator: 'GREATER_THAN', value: 50000 },
    });
    expect(evaluateCondition(workflow.stages[1].condition, { amount: 50000 })).toBe(false);
    expect(evaluateCondition(workflow.stages[1].condition, { amount: 50001 })).toBe(true);

    const purchaseType = await createPurchaseType(context.adminToken);
    expect(purchaseType.status).toBe(201);
    expect(purchaseType.body.data.fields.find((field) => field.semantic === 'AMOUNT').key).toBe('estimatedCost');

    const customStages = workflow.stages.map((stage) => {
      const value = stage.toObject();
      if (value.assignment.roleId) value.assignment.roleId = String(value.assignment.roleId);
      if (value.assignment.userId) value.assignment.userId = String(value.assignment.userId);
      if (!value.sla?.duration) value.sla = null;
      return value;
    });
    const update = await request(app)
      .patch(`/api/approval-workflows/${workflow._id}`)
      .set(authHeader(context.adminToken))
      .send({
        name: workflow.name,
        description: 'Administrator customization',
        requestTypeId: null,
        stages: customStages,
      });
    expect(update.status, JSON.stringify(update.body)).toBe(200);
    expect(update.body.data).toMatchObject({
      definitionType: 'APPROVAL_WORKFLOW',
      isDefault: true,
      isActive: true,
      version: 2,
      description: 'Administrator customization',
    });

    const listed = await request(app)
      .get('/api/approval-workflows?isActive=true')
      .set(authHeader(context.adminToken));
    expect(listed.status).toBe(200);
    expect(listed.body.data.pagination.total).toBe(1);
    expect(listed.body.data.items[0].id).toBe(update.body.data.id);

    const initializedAgain = await withTransaction((session) => initializeDefaultApprovalWorkflow({
      session,
      organizationId: context.organizationId,
      actorId: context.admin._id,
    }));
    expect(String(initializedAgain._id)).toBe(update.body.data.id);
    expect(initializedAgain.description).toBe('Administrator customization');
    expect(await WorkflowDefinition.countDocuments({
      organizationId: context.organizationId,
      definitionType: 'APPROVAL_WORKFLOW',
      isDefault: true,
      isActive: true,
    })).toBe(1);
    workflow = await WorkflowDefinition.findById(update.body.data.id);
    expect(workflow.isActive).toBe(true);
  });

  it('evaluates the default Finance stage from Purchase Request estimatedCost only', async () => {
    const context = await setup('default-finance-condition');
    const purchaseType = await createPurchaseType(context.adminToken, {
      code: 'PURCHASE_FINANCE_CONDITION',
    });
    expect(purchaseType.status).toBe(201);
    const purchaseCases = [
      { amount: 30000, financeStatus: 'SKIPPED' },
      { amount: 50000, financeStatus: 'SKIPPED' },
      { amount: 75000, financeStatus: 'PENDING' },
    ];

    for (const [index, testCase] of purchaseCases.entries()) {
      const created = await request(app)
        .post('/api/requests')
        .set(authHeader(context.memberToken))
        .send({
          departmentId: String(context.department._id),
          requestTypeId: purchaseType.body.data.id,
          title: `Purchase condition ${index}`,
          details: {
            itemName: `Item ${index}`,
            quantity: 1,
            estimatedCost: testCase.amount,
            justification: 'Required purchase justification.',
          },
        });
      expect(created.status).toBe(201);
      const storedDraft = await Request.findById(created.body.data.id).lean();
      expect(storedDraft.amount).toBe(testCase.amount);
      expect(storedDraft.details.estimatedCost).toBe(testCase.amount);

      const submitted = await request(app)
        .post(`/api/requests/${created.body.data.id}/submit`)
        .set(authHeader(context.memberToken))
        .send({});
      expect(submitted.status).toBe(200);
      const steps = await ApprovalStep.find({ requestId: created.body.data.id, attemptNumber: 1 }).lean();
      const managerStage = steps.find((step) => step.stageId === 'department-manager-approval');
      const financeStage = steps.find((step) => step.stageId === 'finance-approval');
      expect(managerStage).toMatchObject({
        approverType: 'DEPARTMENT_MANAGER',
        status: 'ACTIVE',
        assignmentResolution: 'CLAIM_ONE',
      });
      expect(String(managerStage.approverId)).toBe(String(context.manager._id));
      expect(financeStage?.status).toBe(testCase.financeStatus);
      if (testCase.financeStatus === 'PENDING') {
        expect(financeStage.approverType).toBe('ROLE');
        const claimed = await request(app)
          .post(`/api/approvals/${managerStage._id}/claim`)
          .set(authHeader(context.managerToken))
          .send({});
        expect(claimed.status).toBe(200);
        const approved = await request(app)
          .post(`/api/approvals/${managerStage._id}/approve`)
          .set(authHeader(context.managerToken))
          .send({ comment: 'Department Manager approved the purchase.' });
        expect(approved.status).toBe(200);
        expect((await ApprovalStep.findById(financeStage._id)).status).toBe('ACTIVE');
      }
    }

    const otherType = await createType(context.adminToken, {
      name: 'Amount-like Non-purchase Request',
      code: 'AMOUNT_LIKE_GENERAL',
      fields: [
        { key: 'reason', label: 'Reason', type: 'TEXT', required: true },
        { key: 'amount', label: 'Amount', type: 'NUMBER', required: false },
      ],
    });
    expect(otherType.status).toBe(201);
    const nonPurchase = await request(app)
      .post('/api/requests')
      .set(authHeader(context.memberToken))
      .send({
        departmentId: String(context.department._id),
        requestTypeId: otherType.body.data.id,
        title: 'Non-purchase amount-like request',
        details: { reason: 'Amount-like fields must not trigger Finance.', amount: 75000 },
      });
    expect(nonPurchase.status).toBe(201);
    expect((await Request.findById(nonPurchase.body.data.id)).amount).toBeNull();
    const submitted = await request(app)
      .post(`/api/requests/${nonPurchase.body.data.id}/submit`)
      .set(authHeader(context.memberToken))
      .send({});
    expect(submitted.status).toBe(200);
    const nonPurchaseSteps = await ApprovalStep.find({
      requestId: nonPurchase.body.data.id,
      attemptNumber: 1,
    }).lean();
    expect(nonPurchaseSteps.find((step) => step.stageId === 'department-manager-approval')).toMatchObject({
      approverType: 'DEPARTMENT_MANAGER',
      status: 'ACTIVE',
      assignmentResolution: 'CLAIM_ONE',
    });
    expect(nonPurchaseSteps.find((step) => step.stageId === 'finance-approval')?.status).toBe('SKIPPED');
  });

  it('maps and safely migrates legacy Purchase Request amount fields without changing other configuration', async () => {
    const context = await setup('legacy-purchase-amount');
    const purchaseType = await createPurchaseType(context.adminToken, {
      fields: [
        { key: 'itemName', label: 'Item name', type: 'TEXT', required: true },
        { key: 'quantity', label: 'Quantity', type: 'NUMBER', required: true },
        { key: 'estimatedCost', label: 'Estimated cost', type: 'NUMBER', required: true },
        { key: 'justification', label: 'Justification', type: 'TEXTAREA', required: true },
        { key: 'customNote', label: 'Custom note', type: 'TEXT', required: false },
      ],
    });
    expect(purchaseType.status).toBe(201);
    const originalType = await WorkflowDefinition.findById(purchaseType.body.data.id).lean();
    expect(originalType.fields.find((field) => field.key === 'estimatedCost').semantic).toBeNull();

    const created = await request(app)
      .post('/api/requests')
      .set(authHeader(context.memberToken))
      .send({
        departmentId: String(context.department._id),
        requestTypeId: purchaseType.body.data.id,
        title: 'Legacy Purchase Request',
        details: {
          itemName: 'Development laptop',
          quantity: 1,
          estimatedCost: 75000,
          justification: 'Required for engineering work.',
          customNote: 'Preserve this administrator field.',
        },
      });
    expect(created.status).toBe(201);
    expect(created.body.data.amount).toBe(75000);

      const preview = await migratePurchaseAmountSemantic({
        organizationId: context.organizationId,
        dryRun: true,
      });
      expect(preview).toMatchObject({ scanned: 1, migrated: 1, alreadyConfigured: 0, skipped: 0 });
      expect((await WorkflowDefinition.findById(purchaseType.body.data.id))
        .fields.find((field) => field.key === 'estimatedCost').semantic).toBeNull();

      const migration = await migratePurchaseAmountSemantic({ organizationId: context.organizationId });
    expect(migration).toMatchObject({ scanned: 1, migrated: 1, alreadyConfigured: 0, skipped: 0 });
    const migratedType = await WorkflowDefinition.findById(purchaseType.body.data.id).lean();
    expect(migratedType.fields.find((field) => field.key === 'estimatedCost').semantic).toBe('AMOUNT');
    expect(migratedType.fields.find((field) => field.key === 'customNote')).toMatchObject({
      key: 'customNote',
      label: 'Custom note',
      type: 'TEXT',
      required: false,
    });
    expect(migratedType.fields).toHaveLength(originalType.fields.length);

    const submitted = await request(app)
      .post(`/api/requests/${created.body.data.id}/submit`)
      .set(authHeader(context.memberToken))
      .send({});
    expect(submitted.status).toBe(200);
    expect(submitted.body.data.amount).toBe(75000);
    expect((await ApprovalStep.findOne({
      requestId: created.body.data.id,
      stageId: 'finance-approval',
      attemptNumber: 1,
    })).status).toBe('PENDING');

    const alreadyMigrated = await migratePurchaseAmountSemantic({ organizationId: context.organizationId });
    expect(alreadyMigrated).toMatchObject({ scanned: 1, migrated: 0, alreadyConfigured: 1, skipped: 0 });
  });

  it('represents a CLAIM_ONE manager pool as one claimed stage in approval details and history', async () => {
    const context = await setup('claim-one-stage-history');
    const secondManager = await createUser({
      email: 'request-manager-second-claim-one-history@example.com',
      organizationMemberships: [{
        organizationId: context.organizationId,
        departmentId: context.department._id,
        status: 'ACTIVE',
      }],
    });
    const managerRole = await Role.findOne({
      organizationId: context.organizationId,
      roleType: 'DEPARTMENT_MANAGER',
      status: 'ACTIVE',
    });
    await UserRoleAssignment.create({
      userId: secondManager._id,
      roleId: managerRole._id,
      organizationId: context.organizationId,
      departmentId: context.department._id,
      scopeType: 'DEPARTMENT',
      status: 'ACTIVE',
      assignedBy: context.admin._id,
    });
    context.department.managerIds.push(secondManager._id);
    await context.department.save();
    const secondManagerLogin = await loginRequest({
      email: secondManager.email,
      password: TEST_PASSWORD,
    });
    const secondManagerToken = secondManagerLogin.body.data.accessToken;
    const type = await createPurchaseType(context.adminToken, { code: 'PURCHASE_CLAIM_ONE_HISTORY' });
    const created = await request(app)
      .post('/api/requests')
      .set(authHeader(context.memberToken))
      .send({
        departmentId: String(context.department._id),
        requestTypeId: type.body.data.id,
        title: 'Shared manager approval',
        details: {
          itemName: 'Development laptop',
          quantity: 1,
          estimatedCost: 75000,
          justification: 'Required for engineering work.',
        },
      });
    expect(created.status).toBe(201);
    const submitted = await request(app)
      .post(`/api/requests/${created.body.data.id}/submit`)
      .set(authHeader(context.memberToken))
      .send({});
    expect(submitted.status).toBe(200);

    const managerSteps = await ApprovalStep.find({
      requestId: created.body.data.id,
      stageId: 'department-manager-approval',
      attemptNumber: 1,
    }).sort({ approverId: 1 });
    expect(managerSteps).toHaveLength(2);
    expect(managerSteps.every((step) => step.status === 'ACTIVE')).toBe(true);
    const managerStep = managerSteps.find((step) => step.approverId.equals(context.manager._id));
    const otherStep = managerSteps.find((step) => !step.approverId.equals(context.manager._id));

    const claimed = await request(app)
      .post(`/api/approvals/${managerStep._id}/claim`)
      .set(authHeader(context.managerToken))
      .send({});
    expect(claimed.status).toBe(200);
    const claimOwner = context.manager;
    const claimOwnerToken = context.managerToken;
    const actualClaimedStep = await ApprovalStep.findOne({
      requestId: created.body.data.id,
      stageId: 'department-manager-approval',
      status: 'CLAIMED',
    });

    expect(String(actualClaimedStep._id)).toBe(String(managerStep._id));
    expect(String(actualClaimedStep.claimedBy)).toBe(String(claimOwner._id));
    expect((await ApprovalStep.findById(otherStep._id)).status).toBe('CANCELLED');
    const blockedClaim = await request(app)
      .post(`/api/approvals/${otherStep._id}/claim`)
      .set(authHeader(secondManagerToken))
      .send({});
    expect(blockedClaim.status).toBe(409);
    expect(blockedClaim.body.code).toBe('APPROVAL_CLAIMED');
    const blockedAction = await request(app)
      .post(`/api/approvals/${otherStep._id}/approve`)
      .set(authHeader(secondManagerToken))
      .send({});
    expect(blockedAction.status).toBe(409);
    expect(blockedAction.body.code).toBe('APPROVAL_CLAIMED');

    const details = await request(app)
      .get(`/api/approvals/${actualClaimedStep._id}`)
      .set(authHeader(claimOwnerToken));
    expect(details.status).toBe(200);
    const managerHistory = details.body.data.history.filter(
      (item) => item.stageId === 'department-manager-approval'
    );
    expect(managerHistory).toHaveLength(1);
    expect(managerHistory[0].status).toBe('CLAIMED');
    expect(String(managerHistory[0].claimedBy)).toBe(String(claimOwner._id));
    expect(managerHistory[0].approverIds.map(String).sort()).toEqual(
      [String(context.manager._id), String(secondManager._id)].sort()
    );

    const history = await request(app)
      .get(`/api/requests/${created.body.data.id}/approval-history`)
      .set(authHeader(context.memberToken));
    expect(history.status).toBe(200);
    expect(history.body.data.timeline.filter(
      (event) => event.type === 'APPROVAL_STAGE_GENERATED' &&
        event.metadata.stageId === 'department-manager-approval'
    )).toHaveLength(1);
    const claimEvents = history.body.data.timeline.filter(
      (event) => event.type === 'APPROVAL_CLAIMED' &&
        event.metadata.stageId === 'department-manager-approval'
    );
    expect(claimEvents).toHaveLength(1);
    expect(claimEvents[0].actorId).toBe(String(claimOwner._id));
    expect(claimEvents[0].actorName).toBe(claimOwner.name);
    expect(claimEvents[0].metadata).toMatchObject({
      stageName: 'Department Manager Approval',
      previousStatus: 'ACTIVE',
      newStatus: 'CLAIMED',
    });
  });

  it('lists role-relevant requests and applies derived, stage, requester, date, and search filters', async () => {
    const context = await setup('request-history-filters');
    const purchaseType = await createPurchaseType(context.adminToken, {
      code: 'PURCHASE_HISTORY_FILTERS',
    });
    const created = await request(app)
      .post('/api/requests')
      .set(authHeader(context.memberToken))
      .send({
        departmentId: String(context.department._id),
        requestTypeId: purchaseType.body.data.id,
        title: 'History Filter Laptop',
        priority: 'HIGH',
        details: {
          itemName: 'Laptop',
          quantity: 1,
          estimatedCost: 75000,
          justification: 'Required for engineering work.',
        },
      });
    expect(created.status).toBe(201);
    const submitted = await request(app)
      .post(`/api/requests/${created.body.data.id}/submit`)
      .set(authHeader(context.memberToken))
      .send({});
    expect(submitted.status).toBe(200);

    const managerWaiting = await request(app)
      .get('/api/requests')
      .set(authHeader(context.managerToken))
      .query({ derivedFilter: 'WAITING_FOR_ME' });
    expect(managerWaiting.status).toBe(200);
    expect(managerWaiting.body.data.items.map((item) => item.id)).not.toContain(created.body.data.id);
    expect(managerWaiting.body.data.pagination.total).toBe(0);

    const financeList = await request(app)
      .get('/api/requests')
      .set(authHeader(context.financeToken))
      .query({ status: 'PENDING_APPROVAL' });
    expect(financeList.status).toBe(200);
    expect(financeList.body.data.items.map((item) => item.id)).toContain(created.body.data.id);
    expect(financeList.body.data.items[0].waitingForMe).toBe(false);
    const financeWaitingEarly = await request(app)
      .get('/api/requests')
      .set(authHeader(context.financeToken))
      .query({ derivedFilter: 'WAITING_FOR_ME' });
    expect(financeWaitingEarly.body.data.pagination.total).toBe(0);

    const filtered = await request(app)
      .get('/api/requests')
      .set(authHeader(context.adminToken))
      .query({
        status: 'ALL',
        requestTypeId: purchaseType.body.data.id,
        departmentId: String(context.department._id),
        requesterId: String(context.member._id),
        priority: 'HIGH',
        approvalStage: 'department-manager-approval',
        search: 'History Filter Laptop',
        fromDate: new Date(Date.now() - 60_000).toISOString(),
        toDate: new Date(Date.now() + 60_000).toISOString(),
        sortBy: 'createdAt',
        sortOrder: 'desc',
        page: '1',
        limit: '1',
      });
    expect(filtered.status).toBe(200);
    expect(filtered.body.data.items).toHaveLength(1);
    expect(filtered.body.data.pagination).toMatchObject({ page: 1, limit: 1, total: 1, totalPages: 1 });

    const managerStep = await ApprovalStep.findOne({
      requestId: created.body.data.id,
      stageId: 'department-manager-approval',
      status: 'ACTIVE',
    });
    const claimed = await request(app)
      .post(`/api/approvals/${managerStep._id}/claim`)
      .set(authHeader(context.managerToken))
      .send({});
    expect(claimed.status).toBe(200);
    const approved = await request(app)
      .post(`/api/approvals/${managerStep._id}/approve`)
      .set(authHeader(context.managerToken))
      .send({ comment: 'Manager approved.' });
    expect(approved.status).toBe(200);

    const managerApproved = await request(app)
      .get('/api/requests')
      .set(authHeader(context.managerToken))
      .query({ derivedFilter: 'MY_APPROVED' });
    expect(managerApproved.body.data.items.map((item) => item.id)).not.toContain(created.body.data.id);
    expect(managerApproved.body.data.pagination.total).toBe(0);
    const waitingForFinance = await request(app)
      .get('/api/requests')
      .set(authHeader(context.managerToken))
      .query({ derivedFilter: 'WAITING_FOR_OTHERS' });
    expect(waitingForFinance.body.data.items.map((item) => item.id)).not.toContain(created.body.data.id);

    const financeWaiting = await request(app)
      .get('/api/requests')
      .set(authHeader(context.financeToken))
      .query({ derivedFilter: 'WAITING_FOR_ME' });
    expect(financeWaiting.body.data.items.map((item) => item.id)).toContain(created.body.data.id);
    expect(financeWaiting.body.data.items[0].waitingForMe).toBe(true);
    const financeStep = await ApprovalStep.findOne({
      requestId: created.body.data.id,
      stageId: 'finance-approval',
      status: 'ACTIVE',
    });
    const financeClaim = await request(app)
      .post(`/api/approvals/${financeStep._id}/claim`)
      .set(authHeader(context.financeToken))
      .send({});
    expect(financeClaim.status).toBe(200);
    const financeApprove = await request(app)
      .post(`/api/approvals/${financeStep._id}/approve`)
      .set(authHeader(context.financeToken))
      .send({ comment: 'Finance approved.' });
    expect(financeApprove.status).toBe(200);
    const financeHistory = await request(app)
      .get('/api/requests')
      .set(authHeader(context.financeToken))
      .query({ derivedFilter: 'MY_APPROVED' });
    expect(financeHistory.body.data.items.map((item) => item.id)).toContain(created.body.data.id);

    const history = await request(app)
      .get(`/api/requests/${created.body.data.id}/approval-history`)
      .set(authHeader(context.memberToken));
    expect(history.status).toBe(200);
    const managerDecision = history.body.data.timeline.find((event) => event.type === 'APPROVAL_APPROVED');
    expect(managerDecision).toMatchObject({
      actorId: String(context.manager._id),
      actorName: context.manager.name,
      metadata: {
        stageId: 'department-manager-approval',
        stageName: 'Department Manager Approval',
        sequence: 1,
        previousStatus: 'CLAIMED',
        newStatus: 'APPROVED',
        approverId: String(context.manager._id),
        approverName: context.manager.name,
      },
    });
    expect(history.body.data.timeline.every((event, index, events) =>
      index === 0 || new Date(events[index - 1].timestamp) <= new Date(event.timestamp)
    )).toBe(true);

    const invalidFilter = await request(app)
      .get('/api/requests')
      .set(authHeader(context.adminToken))
      .query({ derivedFilter: 'NOT_A_FILTER' });
    expect(invalidFilter.status).toBe(400);
    const invalidRequester = await request(app)
      .get('/api/requests')
      .set(authHeader(context.adminToken))
      .query({ requesterId: 'not-an-object-id' });
    expect(invalidRequester.status).toBe(400);
  });

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

  it('creates, edits, submits and cancels requests through the approval runtime', async () => {
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
    expect(submitted.body.data.status).toBe('PENDING_APPROVAL');
    expect(await ApprovalStep.countDocuments()).toBeGreaterThan(0);

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
    expect(foreign.status).toBe(200);
    expect(foreign.body.data.id).toBe(created.body.data.id);

    const invalidDetails = await request(app)
      .patch(`/api/requests/${created.body.data.id}`)
      .set(authHeader(context.memberToken))
      .send({ details: { unknown: true } });
    expect(invalidDetails.status).toBe(400);
  });

  it('restricts employee, manager, and organization admin list and detail visibility', async () => {
    const context = await setup('visibility-categories');
    const memberAssignment = await UserRoleAssignment.findOne({
      organizationId: context.organizationId,
      userId: context.member._id,
      status: 'ACTIVE',
    });
    const privateEmployeeRole = await Role.create({
      organizationId: context.organizationId,
      name: 'Private Request Employee',
      roleType: 'EMPLOYEE',
      permissions: DEPARTMENT_MEMBER_PERMISSIONS,
      status: 'ACTIVE',
      createdBy: context.admin._id,
    });
    memberAssignment.scopeType = 'DEPARTMENT';
    memberAssignment.departmentId = context.department._id;
    memberAssignment.roleId = privateEmployeeRole._id;
    await memberAssignment.save();
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
    const secondManager = await createUser({
      email: 'visibility-second-manager@example.com',
      organizationMemberships: [{
        organizationId: context.organizationId,
        departmentId: context.department._id,
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
    await UserRoleAssignment.create({
      userId: secondManager._id,
      roleId: managerRole._id,
      organizationId: context.organizationId,
      departmentId: context.department._id,
      scopeType: 'DEPARTMENT',
      status: 'ACTIVE',
      assignedBy: context.admin._id,
    });
    context.department.managerIds = [manager._id, secondManager._id];
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
    const secondManagerLogin = await loginRequest({ email: secondManager.email, password: TEST_PASSWORD });
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
    const secondManagerRequest = await createStoredRequest(
      secondManager._id,
      context.department._id,
      'REQ-VIS-007'
    );

    const employeeList = await request(app)
      .get('/api/requests')
      .set(authHeader(context.memberToken));
    expect(employeeList.status).toBe(200);
    const employeeAccess = await resolveEffectivePermissions({
      userId: context.member._id,
      organizationId: context.organizationId,
    });
    expect(employeeAccess.organizationPermissions.has('requests.view')).toBe(false);
    expect(employeeAccess.scopedPermissions.get('requests.view')).toContain(String(context.department._id));
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
      ['REQ-VIS-005'].sort()
    );
    expect(managerList.body.data.pagination.total).toBe(1);
    const managerCannotFilterIntoColleagueHistory = await request(app)
      .get('/api/requests')
      .set(authHeader(managerLogin.body.data.accessToken))
      .query({
        status: 'ALL',
        departmentId: String(context.department._id),
        requesterId: String(otherMember._id),
        search: 'REQ-VIS-002',
      });
    expect(managerCannotFilterIntoColleagueHistory.status).toBe(200);
    expect(managerCannotFilterIntoColleagueHistory.body.data.pagination.total).toBe(0);
    const managerCannotUseSearchForAnotherManager = await request(app)
      .get('/api/requests/search')
      .set(authHeader(managerLogin.body.data.accessToken))
      .query({ userId: String(secondManager._id), search: 'REQ-VIS-007' });
    expect(managerCannotUseSearchForAnotherManager.body.data.pagination.total).toBe(0);
    const managerCannotUseDerivedFilterForAssignedRequests = await request(app)
      .get('/api/requests')
      .set(authHeader(managerLogin.body.data.accessToken))
      .query({ derivedFilter: 'WAITING_FOR_ME' });
    expect(managerCannotUseDerivedFilterForAssignedRequests.body.data.pagination.total).toBe(0);

    const adminList = await request(app)
      .get('/api/requests')
      .set(authHeader(context.adminToken));
    expect(adminList.status).toBe(200);
    expect(adminList.body.data.pagination.total).toBe(7);
    expect(adminList.body.data.items.map((item) => item.requestNumber).sort()).toEqual(
      ['REQ-VIS-001', 'REQ-VIS-002', 'REQ-VIS-003', 'REQ-VIS-004', 'REQ-VIS-005', 'REQ-VIS-006', 'REQ-VIS-007'].sort()
    );

    const adminDetails = await request(app)
      .get(`/api/requests/${unrelated._id}`)
      .set(authHeader(context.adminToken));
    expect(adminDetails.status).toBe(200);
    expect(adminDetails.body.data.id).toBe(String(unrelated._id));
    const managerDraftDetails = await request(app)
      .get(`/api/requests/${colleague._id}`)
      .set(authHeader(managerLogin.body.data.accessToken));
    expect(managerDraftDetails.status).toBe(404);
    const managerSecondManagerDetails = await request(app)
      .get(`/api/requests/${secondManagerRequest._id}`)
      .set(authHeader(managerLogin.body.data.accessToken));
    expect(managerSecondManagerDetails.status).toBe(404);
    const managerOwnDraftDetails = await request(app)
      .get(`/api/requests/${managerOwn._id}`)
      .set(authHeader(managerLogin.body.data.accessToken));
    expect(managerOwnDraftDetails.status).toBe(200);
    for (const suffix of ['approval-history', 'approval-progress']) {
      const inaccessibleTracking = await request(app)
        .get(`/api/requests/${colleague._id}/${suffix}`)
        .set(authHeader(managerLogin.body.data.accessToken));
      expect(inaccessibleTracking.status).toBe(404);
    }

    const assignedRequestResponse = await request(app)
      .post('/api/requests')
      .set(authHeader(context.memberToken))
      .send({
        departmentId: String(context.department._id),
        requestTypeId: requestType.body.data.id,
        title: 'Manager inbox visibility request',
        details: { reason: 'Must remain inbox-only for the manager.' },
      });
    expect(assignedRequestResponse.status).toBe(201);
    const assignedRequestId = assignedRequestResponse.body.data.id;
    const submittedAssignedRequest = await request(app)
      .post(`/api/requests/${assignedRequestId}/submit`)
      .set(authHeader(context.memberToken))
      .send({});
    expect(submittedAssignedRequest.status).toBe(200);
    const managerInbox = await request(app)
      .get('/api/approvals/inbox')
      .set(authHeader(managerLogin.body.data.accessToken))
      .query({ category: 'available', requestId: assignedRequestId });
    expect(managerInbox.status).toBe(200);
    expect(managerInbox.body.data.items.length).toBeGreaterThan(0);
    const managerStep = managerInbox.body.data.items.find(
      (item) => String(item.approverId) === String(manager._id)
    );
    expect(managerStep).toBeTruthy();

    for (const endpoint of [
      `/api/requests/${assignedRequestId}`,
      `/api/requests/${assignedRequestId}/approval-history`,
      `/api/requests/${assignedRequestId}/approval-progress`,
    ]) {
      const historyAccess = await request(app)
        .get(endpoint)
        .set(authHeader(managerLogin.body.data.accessToken));
      expect(historyAccess.status).toBe(404);
    }
    const managerClaim = await request(app)
      .post(`/api/approvals/${managerStep._id}/claim`)
      .set(authHeader(managerLogin.body.data.accessToken))
      .send({});
    expect(managerClaim.status).toBe(200);
    const managerApprove = await request(app)
      .post(`/api/approvals/${managerStep._id}/approve`)
      .set(authHeader(managerLogin.body.data.accessToken))
      .send({ comment: 'Approved from the inbox.' });
    expect(managerApprove.status).toBe(200);
    const stillNotInManagerHistory = await request(app)
      .get('/api/requests')
      .set(authHeader(managerLogin.body.data.accessToken))
      .query({ status: 'ALL', departmentId: String(context.department._id) });
    expect(stillNotInManagerHistory.body.data.items.map((item) => item.id)).not.toContain(assignedRequestId);
    const stillNotInManagerDetails = await request(app)
      .get(`/api/requests/${assignedRequestId}`)
      .set(authHeader(managerLogin.body.data.accessToken));
    expect(stillNotInManagerDetails.status).toBe(404);

    const foreignOrganizationId = new mongoose.Types.ObjectId();
    const foreignRequest = await createStoredRequest(
      otherMember._id,
      context.department._id,
      'REQ-FOREIGN-001'
    );
    foreignRequest.organizationId = foreignOrganizationId;
    await foreignRequest.save();
    const crossOrganizationDetail = await request(app)
      .get(`/api/requests/${foreignRequest._id}`)
      .set(authHeader(context.adminToken));
    expect(crossOrganizationDetail.status).toBe(404);
    const crossOrganizationList = await request(app)
      .get('/api/requests')
      .set(authHeader(context.adminToken))
      .query({ status: 'ALL' });
    expect(crossOrganizationList.body.data.items.map((item) => item.id)).not.toContain(String(foreignRequest._id));

    const adminDraftDetails = await request(app)
      .get(`/api/requests/${own._id}`)
      .set(authHeader(context.adminToken));
    expect(adminDraftDetails.status).toBe(200);
    expect(adminDraftDetails.body.data.id).toBe(String(own._id));
    expect(managerLogin.body.data.accessToken).toBeTruthy();
    expect(secondManagerLogin.body.data.accessToken).toBeTruthy();
    expect(otherMemberLogin.body.data.accessToken).toBeTruthy();
    expect(manager._id).toBeTruthy();
    expect(DEPARTMENT_MEMBER_PERMISSIONS).toContain('requests.view');
    expect(managed._id).toBeTruthy();
    expect(managerOwn._id).toBeTruthy();
    expect(adminOwn._id).toBeTruthy();
  });

  it('applies custom request.view department scope to request lists, search, details, and tracking', async () => {
    const context = await setup('custom-request-view-scope');
    const otherDepartment = await Department.create({
      organizationId: context.organizationId,
      name: 'Restricted Custom Viewer Department',
      status: 'ACTIVE',
    });
    const viewer = await createUser({
      email: 'custom-request-viewer@example.com',
      organizationMemberships: [{
        organizationId: context.organizationId,
        departmentId: context.department._id,
        status: 'ACTIVE',
      }],
    });
    const viewerRole = await Role.create({
      organizationId: context.organizationId,
      name: 'Department Request Viewer',
      roleType: 'CUSTOM',
      permissions: ['requests.view'],
      status: 'ACTIVE',
      createdBy: context.admin._id,
    });
    await UserRoleAssignment.create({
      userId: viewer._id,
      roleId: viewerRole._id,
      organizationId: context.organizationId,
      departmentId: context.department._id,
      scopeType: 'DEPARTMENT',
      status: 'ACTIVE',
      assignedBy: context.admin._id,
    });
    const viewerLogin = await loginRequest({ email: viewer.email, password: TEST_PASSWORD });
    const requester = await createUser({
      email: 'custom-request-scope-requester@example.com',
      organizationMemberships: [{
        organizationId: context.organizationId,
        departmentId: context.department._id,
        status: 'ACTIVE',
      }],
    });
    const createScopedRequest = (departmentId, requestNumber) => Request.create({
      organizationId: context.organizationId,
      requesterId: requester._id,
      requestNumber,
      departmentId,
      requestType: 'CUSTOM_SCOPE',
      title: requestNumber,
      details: {},
      status: 'PENDING_APPROVAL',
      currentSequence: 1,
    });
    const visibleRequest = await createScopedRequest(context.department._id, 'REQ-CUSTOM-SCOPE-001');
    const hiddenRequest = await createScopedRequest(otherDepartment._id, 'REQ-CUSTOM-SCOPE-002');
    const token = viewerLogin.body.data.accessToken;

    const list = await request(app).get('/api/requests').set(authHeader(token));
    const filteredSearch = await request(app)
      .get('/api/requests/search')
      .set(authHeader(token))
      .query({
        search: 'REQ-CUSTOM-SCOPE-002',
        departmentId: String(otherDepartment._id),
        userId: String(requester._id),
      });
    const visibleDetails = await request(app)
      .get(`/api/requests/${visibleRequest._id}`)
      .set(authHeader(token));
    const hiddenDetails = await request(app)
      .get(`/api/requests/${hiddenRequest._id}`)
      .set(authHeader(token));
    const hiddenProgress = await request(app)
      .get(`/api/requests/${hiddenRequest._id}/approval-progress`)
      .set(authHeader(token));

    expect(viewerLogin.status).toBe(200);
    expect(list.status).toBe(200);
    expect(list.body.data.items.map((item) => item.id)).toEqual([String(visibleRequest._id)]);
    expect(filteredSearch.status).toBe(200);
    expect(filteredSearch.body.data.pagination.total).toBe(0);
    expect(visibleDetails.status).toBe(200);
    expect(hiddenDetails.status).toBe(404);
    expect(hiddenProgress.status).toBe(404);
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
        status: 'PENDING_APPROVAL',
        search: 'Search purchase',
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

  it('supports approval inbox, return for revision, and resubmission cycles', async () => {
    const context = await setup('phase3');
    const type = await createType(context.adminToken, {
      name: 'Phase 3 Request',
      code: 'PHASE3_REQUEST',
      fields: [{ key: 'reason', label: 'Reason', type: 'TEXT', required: true }],
    });
    const created = await request(app)
      .post('/api/requests')
      .set(authHeader(context.memberToken))
      .send({
        departmentId: String(context.department._id),
        requestTypeId: type.body.data.id,
        title: 'Phase 3 request',
        details: { reason: 'Initial reason' },
      });
    expect(created.status).toBe(201);
    const submitted = await request(app)
      .post(`/api/requests/${created.body.data.id}/submit`)
      .set(authHeader(context.memberToken))
      .send({});
    expect(submitted.status).toBe(200);

    const inbox = await request(app)
      .get('/api/approvals/inbox')
      .set(authHeader(context.managerToken))
      .query({ category: 'available' });
    expect(inbox.status).toBe(200);
    expect(inbox.body.data.pagination.total).toBe(1);
    const stepId = inbox.body.data.items[0]._id;

    const details = await request(app)
      .get(`/api/approvals/${stepId}`)
      .set(authHeader(context.managerToken));
    expect(details.status).toBe(200);
    expect(details.body.data.request.requesterId._id).toBe(context.member._id.toString());

    const claimed = await request(app)
      .post(`/api/approvals/${stepId}/claim`)
      .set(authHeader(context.managerToken))
      .send({});
    expect(claimed.status).toBe(200);
    const returned = await request(app)
      .post(`/api/approvals/${stepId}/return`)
      .set(authHeader(context.managerToken))
      .send({ reason: 'Please provide more detail.' });
    expect(returned.status).toBe(200);

    const progress = await request(app)
      .get(`/api/requests/${created.body.data.id}/approval-progress`)
      .set(authHeader(context.memberToken));
    expect(progress.status).toBe(200);
    expect(progress.body.data.request.status).toBe('RETURNED');

    const history = await request(app)
      .get(`/api/requests/${created.body.data.id}/approval-history`)
      .set(authHeader(context.memberToken));
    expect(history.status).toBe(200);
    expect(history.body.data.timeline.some((event) => event.type === 'REQUEST_RETURNED')).toBe(true);
    const managerReturned = await request(app)
      .get('/api/requests')
      .set(authHeader(context.managerToken))
      .query({ derivedFilter: 'MY_RETURNED' });
    expect(managerReturned.body.data.items.map((item) => item.id)).not.toContain(created.body.data.id);
    const managerActions = await request(app)
      .get('/api/requests')
      .set(authHeader(context.managerToken))
      .query({ derivedFilter: 'MY_ACTIONS' });
    expect(managerActions.body.data.items.map((item) => item.id)).not.toContain(created.body.data.id);

    const edited = await request(app)
      .patch(`/api/requests/${created.body.data.id}`)
      .set(authHeader(context.memberToken))
      .send({ details: { reason: 'Revised reason' } });
    expect(edited.status).toBe(200);
    const resubmitted = await request(app)
      .post(`/api/requests/${created.body.data.id}/resubmit`)
      .set(authHeader(context.memberToken))
      .send({});
    expect(resubmitted.status).toBe(200);
    expect(resubmitted.body.data.status).toBe('PENDING_APPROVAL');
    expect((await ApprovalStep.find({ requestId: created.body.data.id }).distinct('attemptNumber')).sort()).toEqual([1, 2]);

    const requestToReject = await request(app)
      .post('/api/requests')
      .set(authHeader(context.memberToken))
      .send({
        departmentId: String(context.department._id),
        requestTypeId: type.body.data.id,
        title: 'Phase 3 rejected request',
        details: { reason: 'Reason for rejection test' },
      });
    expect(requestToReject.status).toBe(201);
    await request(app)
      .post(`/api/requests/${requestToReject.body.data.id}/submit`)
      .set(authHeader(context.memberToken))
      .send({});
    const rejectionStep = await ApprovalStep.findOne({
      requestId: requestToReject.body.data.id,
      status: 'ACTIVE',
    });
    const rejectionClaim = await request(app)
      .post(`/api/approvals/${rejectionStep._id}/claim`)
      .set(authHeader(context.managerToken))
      .send({});
    expect(rejectionClaim.status).toBe(200);
    const rejected = await request(app)
      .post(`/api/approvals/${rejectionStep._id}/reject`)
      .set(authHeader(context.managerToken))
      .send({ comment: 'Insufficient information.' });
    expect(rejected.status).toBe(200);
    const managerRejected = await request(app)
      .get('/api/requests')
      .set(authHeader(context.managerToken))
      .query({ derivedFilter: 'MY_REJECTED' });
    expect(managerRejected.body.data.items.map((item) => item.id)).not.toContain(requestToReject.body.data.id);
  });

  it('allows delegated approvers to read approval details while preserving the original approver', async () => {
    const context = await setup('delegation');
    const delegation = await request(app)
      .post('/api/approval-delegations')
      .set(authHeader(context.managerToken))
      .send({
        delegateId: String(context.admin._id),
        scopeType: 'DEPARTMENT',
        departmentId: String(context.department._id),
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        endsAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
    expect(delegation.status).toBe(201);
    const type = await createType(context.adminToken, {
      name: 'Delegated Request',
      code: 'DELEGATED_REQUEST',
      fields: [{ key: 'reason', label: 'Reason', type: 'TEXT', required: true }],
    });
    const created = await request(app)
      .post('/api/requests')
      .set(authHeader(context.memberToken))
      .send({
        departmentId: String(context.department._id),
        requestTypeId: type.body.data.id,
        title: 'Delegated request',
        details: { reason: 'Delegation test' },
      });
    await request(app)
      .post(`/api/requests/${created.body.data.id}/submit`)
      .set(authHeader(context.memberToken))
      .send({});
    const inbox = await request(app)
      .get('/api/approvals/inbox')
      .set(authHeader(context.adminToken))
      .query({ category: 'available' });
    expect(inbox.status).toBe(200);
    expect(inbox.body.data.pagination.total).toBe(1);
    const step = inbox.body.data.items[0];
    const details = await request(app)
      .get(`/api/approvals/${step._id}`)
      .set(authHeader(context.adminToken));
    expect(details.status).toBe(200);
    expect(details.body.data.approval.approverId).toBe(String(context.manager._id));
    expect(String(details.body.data.request._id)).toBe(created.body.data.id);

    const unauthorized = await request(app)
      .get(`/api/approvals/${step._id}`)
      .set(authHeader(context.memberToken));
    expect(unauthorized.status).toBe(404);
  });

  it('supports scoped approver delegation without changing the original approver', async () => {
    const context = await setup('delegation');
    const delegation = await request(app)
      .post('/api/approval-delegations')
      .set(authHeader(context.managerToken))
      .send({
        delegateId: String(context.admin._id),
        scopeType: 'DEPARTMENT',
        departmentId: String(context.department._id),
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        endsAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
    expect(delegation.status).toBe(201);
    const type = await createType(context.adminToken, {
      name: 'Delegated Request',
      code: 'DELEGATED_REQUEST',
      fields: [{ key: 'reason', label: 'Reason', type: 'TEXT', required: true }],
    });
    const created = await request(app)
      .post('/api/requests')
      .set(authHeader(context.memberToken))
      .send({
        departmentId: String(context.department._id),
        requestTypeId: type.body.data.id,
        title: 'Delegated request',
        details: { reason: 'Delegation test' },
      });
    await request(app)
      .post(`/api/requests/${created.body.data.id}/submit`)
      .set(authHeader(context.memberToken))
      .send({});
    const inbox = await request(app)
      .get('/api/approvals/inbox')
      .set(authHeader(context.adminToken))
      .query({ category: 'available' });
    expect(inbox.status).toBe(200);
    expect(inbox.body.data.pagination.total).toBe(1);
    const step = inbox.body.data.items[0];
    expect(step.approverId).toBe(String(context.manager._id));
    const claimed = await request(app)
      .post(`/api/approvals/${step._id}/claim`)
      .set(authHeader(context.adminToken))
      .send({});
    expect(claimed.status).toBe(200);
    const stored = await ApprovalStep.findById(step._id).lean();
    expect(String(stored.delegationId)).toBe(delegation.body.data.id);
    expect(String(stored.actedOnBehalfOf)).toBe(String(context.manager._id));
    const revoked = await request(app)
      .post(`/api/approval-delegations/${delegation.body.data.id}/revoke`)
      .set(authHeader(context.managerToken))
      .send({});
    expect(revoked.status).toBe(200);
    const revokedDelegateAction = await request(app)
      .post(`/api/approvals/${step._id}/approve`)
      .set(authHeader(context.adminToken))
      .send({ comment: 'A revoked delegate must not act.' });
    expect(revokedDelegateAction.status).toBe(403);
  });

  it('limits delegated request history and inbox access to the active department and stage scope', async () => {
    const context = await setup('delegation-history-scope');
    const departmentB = await Department.create({
      organizationId: context.organizationId,
      name: 'Delegated Finance',
      status: 'ACTIVE',
    });
    context.member.organizationMemberships.push({
      membershipId: new mongoose.Types.ObjectId(),
      organizationId: context.organizationId,
      departmentId: departmentB._id,
      status: 'ACTIVE',
    });
    await context.member.save();

    const managerRole = await Role.findOne({
      organizationId: context.organizationId,
      roleType: 'DEPARTMENT_MANAGER',
      status: 'ACTIVE',
    });
    await UserRoleAssignment.create({
      userId: context.manager._id,
      roleId: managerRole._id,
      organizationId: context.organizationId,
      departmentId: departmentB._id,
      scopeType: 'DEPARTMENT',
      status: 'ACTIVE',
      assignedBy: context.admin._id,
    });
    departmentB.managerIds = [context.manager._id];
    await departmentB.save();

    const delegate = await createUser({
      email: 'scoped-history-delegate@example.com',
      organizationMemberships: [{
        organizationId: context.organizationId,
        departmentId: context.department._id,
        status: 'ACTIVE',
      }],
    });
    const delegateRole = await Role.create({
      organizationId: context.organizationId,
      name: 'Scoped Approval Delegate',
      roleType: 'CUSTOM',
      permissions: ['requests.approve'],
      status: 'ACTIVE',
      createdBy: context.admin._id,
    });
    await UserRoleAssignment.create([
      {
        userId: delegate._id,
        roleId: delegateRole._id,
        organizationId: context.organizationId,
        departmentId: context.department._id,
        scopeType: 'DEPARTMENT',
        status: 'ACTIVE',
        assignedBy: context.admin._id,
      },
      {
        userId: delegate._id,
        roleId: delegateRole._id,
        organizationId: context.organizationId,
        departmentId: departmentB._id,
        scopeType: 'DEPARTMENT',
        status: 'ACTIVE',
        assignedBy: context.admin._id,
      },
    ]);
    const delegateLogin = await loginRequest({ email: delegate.email, password: TEST_PASSWORD });
    const delegation = await request(app)
      .post('/api/approval-delegations')
      .set(authHeader(context.managerToken))
      .send({
        delegateId: String(delegate._id),
        scopeType: 'DEPARTMENT',
        departmentId: String(context.department._id),
        stageIds: [],
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        endsAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
    expect(delegation.status).toBe(201);

    const type = await createType(context.adminToken, {
      name: 'Delegation History Scope',
      code: 'DELEGATION_HISTORY_SCOPE',
      fields: [{ key: 'reason', label: 'Reason', type: 'TEXT', required: true }],
    });
    const createAndSubmit = async (departmentId, title) => {
      const created = await request(app)
        .post('/api/requests')
        .set(authHeader(context.memberToken))
        .send({
          departmentId: String(departmentId),
          requestTypeId: type.body.data.id,
          title,
          details: { reason: title },
        });
      expect(created.status).toBe(201);
      const submitted = await request(app)
        .post(`/api/requests/${created.body.data.id}/submit`)
        .set(authHeader(context.memberToken))
        .send({});
      expect(submitted.status).toBe(200);
      return created.body.data.id;
    };
    const departmentRequestId = await createAndSubmit(context.department._id, 'Delegation department request');
    const otherDepartmentRequestId = await createAndSubmit(departmentB._id, 'Delegation other department request');

    const delegatedHistory = await request(app)
      .get('/api/requests')
      .set(authHeader(delegateLogin.body.data.accessToken))
      .query({ status: 'ALL' });
    expect(delegatedHistory.body.data.items.map((item) => item.id)).toEqual([departmentRequestId]);
    const delegatedInbox = await request(app)
      .get('/api/approvals/inbox')
      .set(authHeader(delegateLogin.body.data.accessToken))
      .query({ category: 'available' });
    expect(delegatedInbox.body.data.items.map((item) => String(item.requestId))).toContain(departmentRequestId);
    expect(delegatedInbox.body.data.items.map((item) => String(item.requestId))).not.toContain(otherDepartmentRequestId);

    const managerUser = await User.findById(context.manager._id);
    const savedDelegation = managerUser.approvalDelegations.id(delegation.body.data.id);
    savedDelegation.stageIds = ['finance-approval'];
    await managerUser.save();
    const stageRestrictedHistory = await request(app)
      .get(`/api/requests/${departmentRequestId}`)
      .set(authHeader(delegateLogin.body.data.accessToken));
    expect(stageRestrictedHistory.status).toBe(404);
    const stageRestrictedInbox = await request(app)
      .get('/api/approvals/inbox')
      .set(authHeader(delegateLogin.body.data.accessToken))
      .query({ category: 'available' });
    expect(stageRestrictedInbox.body.data.items).toHaveLength(0);

    savedDelegation.stageIds = [];
    savedDelegation.endsAt = new Date(Date.now() - 1_000);
    await managerUser.save();
    const expiredDelegationHistory = await request(app)
      .get(`/api/requests/${departmentRequestId}`)
      .set(authHeader(delegateLogin.body.data.accessToken));
    expect(expiredDelegationHistory.status).toBe(404);
    const expiredDelegationInbox = await request(app)
      .get('/api/approvals/inbox')
      .set(authHeader(delegateLogin.body.data.accessToken))
      .query({ category: 'available' });
    expect(expiredDelegationInbox.body.data.items).toHaveLength(0);
  });

  it('releases expired CLAIM_ONE ownership and allows another manager to claim the stage', async () => {
    const context = await setup('claim-expiry');
    const secondManager = await createUser({
      email: 'request-manager-second-claim-expiry@example.com',
      organizationMemberships: [{
        membershipId: new mongoose.Types.ObjectId(),
        organizationId: context.organizationId,
        departmentId: context.department._id,
        status: 'ACTIVE',
      }],
    });
    const managerRole = await Role.findOne({ organizationId: context.organizationId, roleType: 'DEPARTMENT_MANAGER' });
    await UserRoleAssignment.create({
      userId: secondManager._id,
      roleId: managerRole._id,
      organizationId: context.organizationId,
      departmentId: context.department._id,
      scopeType: 'DEPARTMENT',
      status: 'ACTIVE',
      assignedBy: context.admin._id,
    });
    context.department.managerIds.push(secondManager._id);
    await context.department.save();
    const secondManagerLogin = await loginRequest({ email: secondManager.email, password: TEST_PASSWORD });

    const workflow = await WorkflowDefinition.findOne({ organizationId: context.organizationId, isDefault: true, isActive: true });
    workflow.stages[0].sla = {
      duration: 10,
      unit: 'MINUTES',
      claimExpiry: { duration: 1, unit: 'MINUTES' },
    };
    await workflow.save();

    const type = await createType(context.adminToken, {
      name: 'Claim Expiry Request',
      code: 'CLAIM_EXPIRY',
      fields: [{ key: 'reason', label: 'Reason', type: 'TEXT', required: true }],
    });
    const created = await request(app)
      .post('/api/requests')
      .set(authHeader(context.memberToken))
      .send({
        departmentId: String(context.department._id),
        requestTypeId: type.body.data.id,
        title: 'Claim expiry reassignment',
        details: { reason: 'Test claim reassignment' },
      });
    await request(app).post(`/api/requests/${created.body.data.id}/submit`)
      .set(authHeader(context.memberToken)).send({});

    const managerInbox = await request(app).get('/api/approvals/inbox')
      .set(authHeader(context.managerToken)).query({ category: 'available' });
    const secondInbox = await request(app).get('/api/approvals/inbox')
      .set(authHeader(secondManagerLogin.body.data.accessToken)).query({ category: 'available' });
    expect(managerInbox.body.data.pagination.total).toBe(1);
    expect(secondInbox.body.data.pagination.total).toBe(1);
    const managerStep = managerInbox.body.data.items[0];
    const claimed = await request(app).post(`/api/approvals/${managerStep._id}/claim`)
      .set(authHeader(context.managerToken)).send({});
    expect(claimed.status).toBe(200);

    const lockedInbox = await request(app).get('/api/approvals/inbox')
      .set(authHeader(secondManagerLogin.body.data.accessToken)).query({ category: 'available' });
    expect(lockedInbox.body.data.pagination.total).toBe(0);
    await ApprovalStep.updateMany({
      requestId: managerStep.requestId,
      attemptNumber: managerStep.attemptNumber,
      sequence: managerStep.sequence,
      claimedBy: context.manager._id,
    }, { $set: { claimExpiresAt: new Date(Date.now() - 1000) } });

    const maintenance = await processApprovalMaintenance({ now: new Date(), send: async () => {} });
    expect(maintenance.claimsReleased).toBe(1);
    const availableAgain = await request(app).get('/api/approvals/inbox')
      .set(authHeader(secondManagerLogin.body.data.accessToken)).query({ category: 'available' });
    expect(availableAgain.body.data.pagination.total).toBe(1);
    const secondStep = availableAgain.body.data.items[0];
    const reassigned = await request(app).post(`/api/approvals/${secondStep._id}/claim`)
      .set(authHeader(secondManagerLogin.body.data.accessToken)).send({});
    expect(reassigned.status).toBe(200);

    const staleClaimantAction = await request(app).post(`/api/approvals/${managerStep._id}/approve`)
      .set(authHeader(context.managerToken)).send({ comment: 'Stale claimant must not act.' });
    expect(staleClaimantAction.status).toBe(409);
    const reassignedAction = await request(app).post(`/api/approvals/${secondStep._id}/approve`)
      .set(authHeader(secondManagerLogin.body.data.accessToken)).send({ comment: 'Reassigned approval.' });
    expect(reassignedAction.status).toBe(200);
    expect(String((await ApprovalStep.findById(secondStep._id)).decidedBy)).toBe(String(secondManager._id));
    expect(await AuditLog.exists({ action: 'APPROVAL_CLAIM_EXPIRED', resourceId: managerStep._id })).toBeTruthy();
  });

  it('does not send SLA reminders early and processes overdue, reminder, and escalation events once due', async () => {
    const context = await setup('sla-maintenance');
    const workflow = await WorkflowDefinition.findOne({ organizationId: context.organizationId, isDefault: true, isActive: true });
    workflow.stages[0].sla = {
      duration: 10,
      unit: 'MINUTES',
      reminders: [{ after: 5, unit: 'MINUTES' }],
      escalation: {
        enabled: true,
        after: 1,
        unit: 'MINUTES',
        targetType: 'USER',
        targetId: context.admin._id,
      },
    };
    await workflow.save();
    const type = await createType(context.adminToken, {
      name: 'SLA Request',
      code: 'SLA_REQUEST',
      fields: [{ key: 'reason', label: 'Reason', type: 'TEXT', required: true }],
    });
    const created = await request(app)
      .post('/api/requests')
      .set(authHeader(context.memberToken))
      .send({
        departmentId: String(context.department._id),
        requestTypeId: type.body.data.id,
        title: 'SLA maintenance request',
        details: { reason: 'Test scheduled notices' },
      });
    await request(app).post(`/api/requests/${created.body.data.id}/submit`)
      .set(authHeader(context.memberToken)).send({});
    const step = await ApprovalStep.findOne({ requestId: created.body.data.id, status: 'ACTIVE' });
    expect(step.slaDueAt.getTime()).toBeGreaterThan(Date.now());
    const sent = [];
    const send = async (input) => { sent.push(input.event); };

    const early = await processApprovalMaintenance({ now: new Date(), send });
    expect(early.overdueMarked).toBe(0);
    expect(early.remindersSent).toBe(0);
    expect(sent).toEqual([]);

    const now = new Date();
    await ApprovalStep.updateOne({ _id: step._id }, {
      $set: {
        slaDueAt: new Date(now.getTime() - 5 * 60_000),
        nextReminderAt: new Date(now.getTime() - 60_000),
      },
    });
    const processed = await processApprovalMaintenance({ now, send });
    expect(processed.overdueMarked).toBe(1);
    expect(processed.remindersSent).toBe(1);
    expect(processed.escalationsSent).toBe(1);
    expect(sent.sort()).toEqual(['escalated', 'overdue', 'reminder']);

    const repeated = await processApprovalMaintenance({ now: new Date(now.getTime() + 60_000), send });
    expect(repeated.remindersSent).toBe(0);
    expect(repeated.escalationsSent).toBe(0);
    expect(sent).toHaveLength(3);
    expect((await Request.findById(created.body.data.id)).status).toBe('PENDING_APPROVAL');
  });

  it('retries failed reminders and advances ordered escalation levels without duplicates', async () => {
    const context = await setup('sla-retry-levels');
    const workflow = await WorkflowDefinition.findOne({
      organizationId: context.organizationId,
      isDefault: true,
      isActive: true,
    });
    workflow.stages[0].sla = {
      duration: 10,
      unit: 'MINUTES',
      reminders: [
        { after: 1, unit: 'MINUTES' },
        { after: 2, unit: 'MINUTES' },
      ],
      escalation: {
        enabled: true,
        levels: [
          { after: 1, unit: 'MINUTES', targetType: 'USER', targetId: context.admin._id },
          { after: 2, unit: 'MINUTES', targetType: 'USER', targetId: context.manager._id },
        ],
      },
    };
    await workflow.save();
    const type = await createType(context.adminToken, {
      name: 'SLA Retry Request',
      code: 'SLA_RETRY_REQUEST',
      fields: [{ key: 'reason', label: 'Reason', type: 'TEXT', required: true }],
    });
    const created = await request(app)
      .post('/api/requests')
      .set(authHeader(context.memberToken))
      .send({
        departmentId: String(context.department._id),
        requestTypeId: type.body.data.id,
        title: 'SLA retry request',
        details: { reason: 'Retry and escalation-level test' },
      });
    await request(app).post(`/api/requests/${created.body.data.id}/submit`)
      .set(authHeader(context.memberToken)).send({});
    const step = await ApprovalStep.findOne({ requestId: created.body.data.id, status: 'ACTIVE' });
    const now = new Date();
    const slaDueAt = new Date(now.getTime() - 3 * 60_000);
    await ApprovalStep.updateOne({ _id: step._id }, {
      $set: {
        isOverdue: true,
        slaDueAt,
        nextReminderAt: new Date(now.getTime() - 60_000),
      },
    });
    const sent = [];
    const failFirstAttempt = async () => {
      throw new Error('Simulated provider failure.');
    };
    const failed = await processApprovalMaintenance({ now, send: failFirstAttempt });
    expect(failed.remindersSent).toBe(0);
    expect(failed.escalationsSent).toBe(0);
    const afterFailure = await ApprovalStep.findById(step._id).lean();
    expect(afterFailure.reminderCount).toBe(0);
    expect(afterFailure.escalationLevel).toBe(0);
    expect(afterFailure.nextReminderAt.getTime()).toBeGreaterThan(now.getTime());

    const send = async ({ event, recipient }) => sent.push({
      event,
      recipientId: String(recipient._id),
    });
    const firstRetry = await processApprovalMaintenance({
      now: new Date(now.getTime() + 16 * 60_000),
      send,
    });
    expect(firstRetry.remindersSent).toBe(1);
    expect(firstRetry.escalationsSent).toBe(1);
    const secondRetry = await processApprovalMaintenance({
      now: new Date(now.getTime() + 17 * 60_000),
      send,
    });
    expect(secondRetry.remindersSent).toBe(1);
    expect(secondRetry.escalationsSent).toBe(1);
    expect(sent).toEqual([
      { event: 'escalated', recipientId: String(context.admin._id) },
      { event: 'reminder', recipientId: String(context.manager._id) },
      { event: 'escalated', recipientId: String(context.manager._id) },
      { event: 'reminder', recipientId: String(context.manager._id) },
    ]);

    const repeated = await processApprovalMaintenance({
      now: new Date(now.getTime() + 18 * 60_000),
      send,
    });
    expect(repeated.remindersSent).toBe(0);
    expect(repeated.escalationsSent).toBe(0);
    expect(sent).toHaveLength(4);
    const finalStep = await ApprovalStep.findById(step._id).lean();
    expect(finalStep.reminderCount).toBe(2);
    expect(finalStep.escalationLevel).toBe(2);
  });
});
