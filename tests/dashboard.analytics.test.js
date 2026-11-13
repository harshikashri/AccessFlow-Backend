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
import ApprovalStep from '../src/models/ApprovalStep.js';
import AuditLog from '../src/models/AuditLog.js';
import Department from '../src/models/Department.js';
import Organization from '../src/models/Organization.js';
import RequestModel from '../src/models/Request.js';
import Role from '../src/models/Role.js';
import User from '../src/models/User.js';
import UserRoleAssignment from '../src/models/UserRoleAssignment.js';
import WorkflowDefinition from '../src/models/WorkflowDefinition.js';

const authHeader = (token) => ({ Authorization: `Bearer ${token}` });
let sequence = 0;

const createContext = async ({
  permissions,
  scope = 'ORGANIZATION',
  roleType = 'CUSTOM',
  rolePurpose = 'GENERAL',
}) => {
  const suffix = ++sequence;
  const organizationId = new mongoose.Types.ObjectId();
  const departmentId = new mongoose.Types.ObjectId();
  const user = await createUser({
    name: `Dashboard Analytics User ${suffix}`,
    email: `dashboard-analytics-${suffix}@example.com`,
    organizationMemberships: [{
      organizationId,
      departmentId: scope === 'DEPARTMENT' ? departmentId : null,
      status: 'ACTIVE',
    }],
  });
  await Organization.create({
    _id: organizationId,
    name: `Dashboard Analytics Organization ${suffix}`,
    status: 'ACTIVE',
    createdBy: user._id,
  });
  await Department.create({
    _id: departmentId,
    organizationId,
    name: `Dashboard Analytics Department ${suffix}`,
    status: 'ACTIVE',
  });
  const role = await Role.create({
    organizationId,
    name: `Dashboard Analytics Role ${suffix}`,
    roleType,
    rolePurpose,
    permissions,
    status: 'ACTIVE',
    createdBy: user._id,
  });
  await UserRoleAssignment.create({
    userId: user._id,
    roleId: role._id,
    organizationId,
    departmentId: scope === 'DEPARTMENT' ? departmentId : null,
    scopeType: scope,
    status: 'ACTIVE',
    assignedBy: user._id,
  });
  const login = await loginRequest({ email: user.email, password: TEST_PASSWORD });
  expect(login.status).toBe(200);
  return {
    user,
    role,
    organizationId,
    departmentId,
    token: login.body.data.accessToken,
  };
};

const createRequest = async ({
  organizationId,
  requesterId,
  departmentId,
  suffix = ++sequence,
  status = 'DRAFT',
  requestTypeId = null,
  requestTypeName = 'Purchase',
  requestType = 'PURCHASE',
  createdAt = new Date(),
  amount = null,
}) => RequestModel.create({
  organizationId,
  requesterId,
  requestNumber: `DASH-ANALYTICS-${String(suffix).padStart(6, '0')}`,
  departmentId,
  requestType,
  requestTypeId,
  requestTypeName,
  title: `Dashboard analytics request ${suffix}`,
  details: {},
  amount,
  status,
  currentSequence: status === 'PENDING_APPROVAL' ? 1 : 0,
  createdAt,
  updatedAt: createdAt,
});

const createStep = async ({
  organizationId,
  requestId,
  approverId,
  roleId,
  status = 'ACTIVE',
  stageId = 'manager-stage',
  sequenceNumber = 1,
  attemptNumber = 1,
  assignmentResolution = 'CLAIM_ONE',
  claimedBy = null,
  claimExpiresAt = null,
  decidedBy = null,
  decisionAt = null,
  slaStartedAt = null,
  slaDueAt = null,
  actedOnBehalfOf = null,
}) => ApprovalStep.create({
  organizationId,
  requestId,
  attemptNumber,
  workflowDefinitionId: new mongoose.Types.ObjectId(),
  workflowVersion: 1,
  stageId,
  sequence: sequenceNumber,
  stageName: 'Department Manager',
  approverType: 'ROLE',
  assignmentResolution,
  approvalMode: 'ANY',
  approverId,
  roleId,
  status,
  claimedBy,
  claimExpiresAt,
  decidedBy,
  decisionAt,
  slaStartedAt,
  slaDueAt,
  actedOnBehalfOf,
});

const getAnalytics = (token, endpoint, query = {}) =>
  request(app).get(`/api/dashboard/${endpoint}`).set(authHeader(token)).query(query);

describe('Dashboard analytics providers', () => {
  beforeAll(async () => {
    await connectTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await disconnectTestDatabase();
  });

  it('limits request analytics to the employee or manager request-history scope', async () => {
    const context = await createContext({
      permissions: ['dashboard.view', 'requests.view'],
      scope: 'DEPARTMENT',
      roleType: 'DEPARTMENT_MANAGER',
    });
    const other = await createUser({
      name: 'Other department requester',
      email: `dashboard-analytics-other-${++sequence}@example.com`,
      organizationMemberships: [{
        organizationId: context.organizationId,
        departmentId: context.departmentId,
        status: 'ACTIVE',
      }],
    });
    await createRequest({
      organizationId: context.organizationId,
      requesterId: context.user._id,
      departmentId: context.departmentId,
      status: 'APPROVED',
    });
    await createRequest({
      organizationId: context.organizationId,
      requesterId: other._id,
      departmentId: context.departmentId,
      status: 'REJECTED',
    });

    const response = await getAnalytics(context.token, 'request-analytics');
    expect(response.status).toBe(200);
    expect(response.body.data.scope).toBe('AUTHORIZED_REQUEST_HISTORY');
    expect(
      response.body.data.statusDistribution.find(({ status }) => status === 'APPROVED').count,
      JSON.stringify(response.body.data.statusDistribution)
    ).toBe(1);
    expect(response.body.data.statusDistribution.find(({ status }) => status === 'REJECTED').count).toBe(0);
    expect(response.body.data.requestVolumeComparison.currentPeriodCount).toBe(1);
  });

  it('applies custom request-view department scopes to request analytics', async () => {
    const context = await createContext({
      permissions: ['dashboard.view', 'requests.view'],
      scope: 'DEPARTMENT',
    });
    const otherDepartment = await Department.create({
      organizationId: context.organizationId,
      name: `Unauthorized analytics department ${++sequence}`,
      status: 'ACTIVE',
    });
    const requester = await createUser({
      name: 'Scoped analytics requester',
      email: `scoped-analytics-requester-${sequence}@example.com`,
    });
    await createRequest({
      organizationId: context.organizationId,
      requesterId: requester._id,
      departmentId: context.departmentId,
      status: 'APPROVED',
    });
    await createRequest({
      organizationId: context.organizationId,
      requesterId: requester._id,
      departmentId: otherDepartment._id,
      status: 'REJECTED',
    });

    const response = await getAnalytics(context.token, 'request-analytics');
    expect(response.status).toBe(200);
    expect(response.body.data.scope).toBe('DEPARTMENT');
    expect(response.body.data.statusDistribution.find(({ status }) => status === 'APPROVED').count).toBe(1);
    expect(response.body.data.statusDistribution.find(({ status }) => status === 'REJECTED').count).toBe(0);
  });

  it('honors custom organization-scoped requests.view for tenant request analytics', async () => {
    const context = await createContext({
      permissions: ['dashboard.view', 'requests.view'],
    });
    const otherRequester = await createUser({
      name: 'Organization analytics requester',
      email: `organization-analytics-requester-${++sequence}@example.com`,
    });
    await createRequest({
      organizationId: context.organizationId,
      requesterId: context.user._id,
      departmentId: context.departmentId,
      status: 'APPROVED',
    });
    await createRequest({
      organizationId: context.organizationId,
      requesterId: otherRequester._id,
      departmentId: context.departmentId,
      status: 'REJECTED',
    });

    const response = await getAnalytics(context.token, 'request-analytics');
    expect(response.status).toBe(200);
    expect(response.body.data.scope).toBe('ORGANIZATION');
    expect(response.body.data.statusDistribution.find(({ status }) => status === 'APPROVED').count).toBe(1);
    expect(response.body.data.statusDistribution.find(({ status }) => status === 'REJECTED').count).toBe(1);
  });

  it('limits tenant user analytics to the custom role user scope', async () => {
    const context = await createContext({
      permissions: ['dashboard.view', 'users.view'],
      scope: 'DEPARTMENT',
    });
    const sameDepartmentUser = await createUser({
      name: 'Same department analytics user',
      email: `same-department-analytics-${++sequence}@example.com`,
      organizationMemberships: [{
        organizationId: context.organizationId,
        departmentId: context.departmentId,
        status: 'ACTIVE',
      }],
    });
    const otherDepartment = await Department.create({
      organizationId: context.organizationId,
      name: `Other user analytics department ${sequence}`,
      status: 'ACTIVE',
    });
    await createUser({
      name: 'Other department analytics user',
      email: `other-department-analytics-${sequence}@example.com`,
      organizationMemberships: [{
        organizationId: context.organizationId,
        departmentId: otherDepartment._id,
        status: 'ACTIVE',
      }],
    });

    const response = await getAnalytics(context.token, 'user-analytics');
    expect(response.status).toBe(200);
    expect(response.body.data.scope).toBe('AUTHORIZED_DEPARTMENTS');
    expect(response.body.data.userCounts.totalUsers).toBe(2);
    expect(response.body.data.byDepartment).toEqual([
      expect.objectContaining({
        departmentId: String(context.departmentId),
        totalUsers: 2,
      }),
    ]);
    expect(String(sameDepartmentUser.organizationMemberships[0].departmentId))
      .toBe(String(context.departmentId));
  });

  it('returns only department-directory data when request analytics permission is absent', async () => {
    const context = await createContext({
      permissions: ['dashboard.view', 'departments.view'],
      scope: 'DEPARTMENT',
    });
    const response = await getAnalytics(context.token, 'department-analytics');
    expect(response.status).toBe(200);
    expect(response.body.data.scope).toBe('AUTHORIZED_DEPARTMENTS');
    expect(response.body.data.departmentDirectory.total).toBe(1);
    expect(response.body.data.departments).toBeUndefined();
  });

  it('groups request type snapshots by stable type ID and returns organization-wide admin totals', async () => {
    const context = await createContext({
      permissions: ['dashboard.view', 'requests.view'],
      roleType: 'ORGANIZATION_ADMIN',
    });
    const requester = await createUser({
      name: 'Organization requester',
      email: `dashboard-analytics-org-requester-${++sequence}@example.com`,
      organizationMemberships: [{
        organizationId: context.organizationId,
        departmentId: context.departmentId,
        status: 'ACTIVE',
      }],
    });
    const type = await WorkflowDefinition.create({
      organizationId: context.organizationId,
      name: 'Purchase Request',
      definitionType: 'REQUEST_TYPE',
      code: `PURCHASE-${sequence}`,
      fields: [{ key: 'estimatedCost', label: 'Estimated cost', type: 'NUMBER' }],
      createdBy: context.user._id,
    });
    for (const [requestTypeName, status] of [['Purchase Request', 'APPROVED'], ['Purchase', 'REJECTED']]) {
      await createRequest({
        organizationId: context.organizationId,
        requesterId: requester._id,
        departmentId: context.departmentId,
        requestTypeId: type._id,
        requestTypeName,
        status,
      });
    }
    await createRequest({
      organizationId: context.organizationId,
      requesterId: requester._id,
      departmentId: context.departmentId,
      requestTypeId: null,
      requestTypeName: 'Legacy type A',
    });
    await createRequest({
      organizationId: context.organizationId,
      requesterId: requester._id,
      departmentId: context.departmentId,
      requestTypeId: null,
      requestTypeName: 'Legacy type B',
    });
    const foreignOrganizationId = new mongoose.Types.ObjectId();
    await Organization.create({
      _id: foreignOrganizationId,
      name: `Foreign analytics organization ${sequence}`,
      status: 'ACTIVE',
      createdBy: context.user._id,
    });
    await createRequest({
      organizationId: foreignOrganizationId,
      requesterId: requester._id,
      departmentId: context.departmentId,
      status: 'APPROVED',
    });

    const response = await getAnalytics(context.token, 'request-analytics');
    expect(response.status).toBe(200);
    expect(response.body.data.scope).toBe('ORGANIZATION');
    expect(response.body.data.requestTypes).toHaveLength(3);
    const purchaseType = response.body.data.requestTypes.find((item) => item.requestTypeId);
    expect(purchaseType.total).toBe(2);
    expect(response.body.data.requestVolumeComparison.currentPeriodCount).toBe(4);
    expect(purchaseType.statusCounts.find(({ status }) => status === 'APPROVED').count).toBe(1);
    expect(purchaseType.statusCounts.find(({ status }) => status === 'REJECTED').count).toBe(1);
    expect(response.body.data.requestTypes.map(({ requestType }) => requestType))
      .toContain('Legacy type A');
    expect(response.body.data.requestTypes.map(({ requestType }) => requestType))
      .toContain('Legacy type B');
    expect(response.body.data.dateRange).toEqual(expect.objectContaining({
      timeZone: 'UTC',
      interval: '[fromDate, toDate)',
    }));
  });

  it('reports approval workload and department metrics only in effective approval scope', async () => {
    const context = await createContext({
      permissions: ['dashboard.view', 'requests.approve'],
      scope: 'DEPARTMENT',
    });
    const requester = await createUser({
      name: 'Approval analytics requester',
      email: `dashboard-analytics-approver-requester-${++sequence}@example.com`,
      organizationMemberships: [{
        organizationId: context.organizationId,
        departmentId: context.departmentId,
        status: 'ACTIVE',
      }],
    });
    const requestDoc = await createRequest({
      organizationId: context.organizationId,
      requesterId: requester._id,
      departmentId: context.departmentId,
      status: 'PENDING_APPROVAL',
    });
    await createStep({
      organizationId: context.organizationId,
      requestId: requestDoc._id,
      approverId: context.user._id,
      roleId: context.role._id,
    });

    const [approvalResponse, departmentResponse] = await Promise.all([
      getAnalytics(context.token, 'approval-analytics'),
      getAnalytics(context.token, 'department-analytics'),
    ]);
    expect(approvalResponse.status).toBe(200);
    expect(approvalResponse.body.data.workload).toEqual({
      pendingApprovalStages: 1,
      availableToClaimStages: 1,
      currentlyOverdueStages: 0,
    });
    expect(departmentResponse.status).toBe(200);
    expect(departmentResponse.body.data.scope).toBe('AUTHORIZED_APPROVAL_ASSIGNMENTS');
    expect(departmentResponse.body.data.departments).toEqual([
      expect.objectContaining({
        departmentId: String(context.departmentId),
        assignedApprovalStages: 1,
        pendingApprovalStages: 1,
      }),
    ]);
  });

  it('does not count an expired CLAIM_ONE claim as actionable approval workload', async () => {
    const context = await createContext({
      permissions: ['dashboard.view', 'requests.approve'],
      scope: 'DEPARTMENT',
    });
    const requester = await createUser({
      name: 'Expired claim requester',
      email: `dashboard-analytics-expired-claim-${++sequence}@example.com`,
      organizationMemberships: [{
        organizationId: context.organizationId,
        departmentId: context.departmentId,
        status: 'ACTIVE',
      }],
    });
    const requestDoc = await createRequest({
      organizationId: context.organizationId,
      requesterId: requester._id,
      departmentId: context.departmentId,
      status: 'PENDING_APPROVAL',
    });
    await createStep({
      organizationId: context.organizationId,
      requestId: requestDoc._id,
      approverId: context.user._id,
      roleId: context.role._id,
      status: 'CLAIMED',
      claimedBy: context.user._id,
      claimExpiresAt: new Date(Date.now() - 60_000),
    });

    const response = await getAnalytics(context.token, 'approval-analytics');
    expect(response.status).toBe(200);
    expect(response.body.data.workload.pendingApprovalStages).toBe(0);
    expect(response.body.data.workload.availableToClaimStages).toBe(0);
  });

  it('calculates decision duration and SLA compliance only from valid decisions', async () => {
    const context = await createContext({
      permissions: ['dashboard.view', 'requests.approve'],
      scope: 'DEPARTMENT',
    });
    const requester = await createUser({
      name: 'Performance requester',
      email: `dashboard-analytics-performance-${++sequence}@example.com`,
      organizationMemberships: [{
        organizationId: context.organizationId,
        departmentId: context.departmentId,
        status: 'ACTIVE',
      }],
    });
    const requestDoc = await createRequest({
      organizationId: context.organizationId,
      requesterId: requester._id,
      departmentId: context.departmentId,
      status: 'APPROVED',
    });
    const decisionAt = new Date();
    const slaStartedAt = new Date(decisionAt.getTime() - 30 * 60_000);
    await createStep({
      organizationId: context.organizationId,
      requestId: requestDoc._id,
      approverId: context.user._id,
      roleId: context.role._id,
      status: 'APPROVED',
      assignmentResolution: 'DIRECT',
      decidedBy: context.user._id,
      decisionAt,
      slaStartedAt,
      slaDueAt: new Date(decisionAt.getTime() + 30 * 60_000),
    });

    const response = await getAnalytics(context.token, 'approval-analytics');
    expect(response.status).toBe(200);
    expect(response.body.data.performance).toEqual(expect.objectContaining({
      completedDecisions: 1,
      averageDecisionMinutes: 30,
      medianDecisionMinutes: 30,
      slaDecisionSampleSize: 1,
      onTimeDecisions: 1,
      overdueDecisions: 0,
      slaCompliancePercentage: 100,
    }));
  });

  it('limits delegated approval analytics to active department and stage scope', async () => {
    const context = await createContext({
      permissions: ['dashboard.view', 'requests.approve'],
      scope: 'DEPARTMENT',
    });
    const delegator = await createUser({
      name: 'Analytics delegator',
      email: `dashboard-analytics-delegator-${++sequence}@example.com`,
      organizationMemberships: [{
        organizationId: context.organizationId,
        departmentId: context.departmentId,
        status: 'ACTIVE',
      }],
    });
    const now = new Date();
    await User.updateOne({ _id: delegator._id }, {
      $set: {
        approvalDelegations: [
          {
            organizationId: context.organizationId,
            delegateId: context.user._id,
            scopeType: 'DEPARTMENT',
            departmentId: context.departmentId,
            stageIds: ['allowed-stage'],
            startsAt: new Date(now.getTime() - 60_000),
            endsAt: new Date(now.getTime() + 60_000),
            status: 'ACTIVE',
          },
          {
            organizationId: context.organizationId,
            delegateId: context.user._id,
            scopeType: 'DEPARTMENT',
            departmentId: context.departmentId,
            stageIds: [],
            startsAt: new Date(now.getTime() - 120_000),
            endsAt: new Date(now.getTime() - 60_000),
            status: 'ACTIVE',
          },
        ],
      },
    });
    for (const stageId of ['allowed-stage', 'restricted-stage', 'expired-stage']) {
      const requester = await createUser({
        name: `Delegation analytics requester ${stageId}`,
        email: `dashboard-analytics-${stageId}-${++sequence}@example.com`,
        organizationMemberships: [{
          organizationId: context.organizationId,
          departmentId: context.departmentId,
          status: 'ACTIVE',
        }],
      });
      const requestDoc = await createRequest({
        organizationId: context.organizationId,
        requesterId: requester._id,
        departmentId: context.departmentId,
        status: 'PENDING_APPROVAL',
      });
      await createStep({
        organizationId: context.organizationId,
        requestId: requestDoc._id,
        approverId: delegator._id,
        roleId: context.role._id,
        stageId,
      });
    }

    const response = await getAnalytics(context.token, 'approval-analytics');
    expect(response.status).toBe(200);
    expect(response.body.data.workload.pendingApprovalStages).toBe(1);
    expect(response.body.data.workload.availableToClaimStages).toBe(1);
    expect(response.body.data.stages).toHaveLength(1);
    expect(response.body.data.stages[0].stageId).toBe('allowed-stage');
  });

  it('returns only authorized request activity and does not expose audit changes', async () => {
    const context = await createContext({
      permissions: ['dashboard.view', 'requests.view'],
      scope: 'DEPARTMENT',
      roleType: 'EMPLOYEE',
    });
    const other = await createUser({
      name: 'Hidden activity requester',
      email: `dashboard-analytics-hidden-${++sequence}@example.com`,
      organizationMemberships: [{
        organizationId: context.organizationId,
        departmentId: context.departmentId,
        status: 'ACTIVE',
      }],
    });
    const ownRequest = await createRequest({
      organizationId: context.organizationId,
      requesterId: context.user._id,
      departmentId: context.departmentId,
    });
    const hiddenRequest = await createRequest({
      organizationId: context.organizationId,
      requesterId: other._id,
      departmentId: context.departmentId,
    });
    await AuditLog.create([
      {
        organizationId: context.organizationId,
        actorId: context.user._id,
        action: 'REQUEST_CREATED',
        resourceType: 'Request',
        resourceId: ownRequest._id,
        changes: { secret: 'must-not-be-returned' },
        timestamp: new Date(),
      },
      {
        organizationId: context.organizationId,
        actorId: other._id,
        action: 'REQUEST_CREATED',
        resourceType: 'Request',
        resourceId: hiddenRequest._id,
        changes: { secret: 'also-private' },
        timestamp: new Date(),
      },
    ]);

    const response = await getAnalytics(context.token, 'recent-activity');
    expect(response.status).toBe(200);
    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0]).toEqual(expect.objectContaining({
      requestId: String(ownRequest._id),
      actorId: String(context.user._id),
      actorName: context.user.name,
    }));
    expect(JSON.stringify(response.body.data)).not.toContain('must-not-be-returned');
    expect(JSON.stringify(response.body.data)).not.toContain('also-private');
  });

  it('allows audit-only users to see allowlisted events only inside their department scope', async () => {
    const context = await createContext({
      permissions: ['dashboard.view', 'audit_logs.view'],
      scope: 'DEPARTMENT',
    });
    const requester = await createUser({
      name: 'Audit activity requester',
      email: `dashboard-analytics-audit-${++sequence}@example.com`,
      organizationMemberships: [{
        organizationId: context.organizationId,
        departmentId: context.departmentId,
        status: 'ACTIVE',
      }],
    });
    const inScopeRequest = await createRequest({
      organizationId: context.organizationId,
      requesterId: requester._id,
      departmentId: context.departmentId,
    });
    const outsideDepartmentId = new mongoose.Types.ObjectId();
    await Department.create({
      _id: outsideDepartmentId,
      organizationId: context.organizationId,
      name: `Audit-outside department ${sequence}`,
      status: 'ACTIVE',
    });
    const outsideRequest = await createRequest({
      organizationId: context.organizationId,
      requesterId: requester._id,
      departmentId: outsideDepartmentId,
    });
    await AuditLog.create([
      {
        organizationId: context.organizationId,
        actorId: requester._id,
        action: 'REQUEST_SUBMITTED',
        resourceType: 'Request',
        resourceId: inScopeRequest._id,
        timestamp: new Date(),
      },
      {
        organizationId: context.organizationId,
        actorId: requester._id,
        action: 'REQUEST_SUBMITTED',
        resourceType: 'Request',
        resourceId: outsideRequest._id,
        timestamp: new Date(),
      },
    ]);

    const response = await getAnalytics(context.token, 'recent-activity');
    expect(response.status).toBe(200);
    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0].requestId).toBe(String(inScopeRequest._id));
  });

  it('returns an empty activity page for an approver without assigned steps', async () => {
    const context = await createContext({
      permissions: ['dashboard.view', 'requests.approve'],
      scope: 'DEPARTMENT',
    });
    const response = await getAnalytics(context.token, 'recent-activity');
    expect(response.status).toBe(200);
    expect(response.body.data.items).toEqual([]);
    expect(response.body.data.pagination.total).toBe(0);
  });

  it('does not expose request activity for an eligible but unclaimed manager approval', async () => {
    const context = await createContext({
      permissions: ['dashboard.view', 'requests.approve'],
      scope: 'DEPARTMENT',
      roleType: 'DEPARTMENT_MANAGER',
    });
    const requester = await createUser({
      name: 'Unclaimed activity requester',
      email: `dashboard-analytics-unclaimed-${++sequence}@example.com`,
      organizationMemberships: [{
        organizationId: context.organizationId,
        departmentId: context.departmentId,
        status: 'ACTIVE',
      }],
    });
    const assignedRequest = await createRequest({
      organizationId: context.organizationId,
      requesterId: requester._id,
      departmentId: context.departmentId,
      status: 'PENDING_APPROVAL',
    });
    const step = await createStep({
      organizationId: context.organizationId,
      requestId: assignedRequest._id,
      approverId: context.user._id,
      roleId: context.role._id,
      status: 'ACTIVE',
    });
    await AuditLog.create({
      organizationId: context.organizationId,
      actorId: context.user._id,
      action: 'APPROVAL_STAGE_ACTIVATED',
      resourceType: 'Approval',
      resourceId: step._id,
      timestamp: new Date(),
    });

    const response = await getAnalytics(context.token, 'recent-activity');
    expect(response.status).toBe(200);
    expect(response.body.data.items).toEqual([]);
    expect(response.body.data.pagination.total).toBe(0);
  });

  it('paginates activity while preserving the total count and stable ordering', async () => {
    const context = await createContext({
      permissions: ['dashboard.view', 'requests.view'],
    });
    const requestDocs = [];
    for (let index = 0; index < 2; index += 1) {
      requestDocs.push(await createRequest({
        organizationId: context.organizationId,
        requesterId: context.user._id,
        departmentId: context.departmentId,
      }));
    }
    await AuditLog.create(requestDocs.map((requestDoc, index) => ({
      organizationId: context.organizationId,
      actorId: context.user._id,
      action: 'REQUEST_CREATED',
      resourceType: 'Request',
      resourceId: requestDoc._id,
      timestamp: new Date(Date.now() - (1 - index) * 1000),
    })));

    const [firstPage, secondPage] = await Promise.all([
      getAnalytics(context.token, 'recent-activity', { page: '1', limit: '1' }),
      getAnalytics(context.token, 'recent-activity', { page: '2', limit: '1' }),
    ]);
    expect(firstPage.status).toBe(200);
    expect(secondPage.status).toBe(200);
    expect(firstPage.body.data.pagination).toEqual({
      page: 1,
      limit: 1,
      total: 2,
      totalPages: 2,
    });
    expect(secondPage.body.data.pagination.total).toBe(2);
    expect(firstPage.body.data.items[0].activityId).not.toBe(secondPage.body.data.items[0].activityId);
  });

  it('validates analytics date ranges and recent-activity pagination', async () => {
    const context = await createContext({
      permissions: ['dashboard.view', 'requests.view'],
    });
    const invalidPresetCombination = await getAnalytics(context.token, 'request-analytics', {
      range: 'LAST_7_DAYS',
      fromDate: '2025-01-01',
      toDate: '2025-01-02',
    });
    const invalidPage = await getAnalytics(context.token, 'recent-activity', { page: '0' });
    const invalidLimit = await getAnalytics(context.token, 'recent-activity', { limit: '101' });
    const unsafeOffset = await getAnalytics(context.token, 'recent-activity', {
      page: '9007199254740991',
      limit: '100',
    });
    expect(invalidPresetCombination.status).toBe(400);
    expect(invalidPage.status).toBe(400);
    expect(invalidLimit.status).toBe(400);
    expect(unsafeOffset.status).toBe(400);
  });

  it('requires dashboard.view before granting any tenant analytics endpoint', async () => {
    const context = await createContext({
      permissions: ['requests.view'],
    });
    const [requestResponse, approvalResponse, activityResponse] = await Promise.all([
      getAnalytics(context.token, 'request-analytics'),
      getAnalytics(context.token, 'approval-analytics'),
      getAnalytics(context.token, 'recent-activity'),
    ]);
    expect(requestResponse.status).toBe(403);
    expect(requestResponse.body.code).toBe('DASHBOARD_ACCESS_DENIED');
    expect(approvalResponse.status).toBe(403);
    expect(activityResponse.status).toBe(403);
  });

  it('keeps Super Admin analytics platform-only even when tenant requests exist', async () => {
    const tenant = await createContext({
      permissions: ['dashboard.view', 'requests.view'],
      roleType: 'ORGANIZATION_ADMIN',
    });
    await createRequest({
      organizationId: tenant.organizationId,
      requesterId: tenant.user._id,
      departmentId: tenant.departmentId,
      status: 'APPROVED',
    });
    await createSuperAdmin({ email: `dashboard-phase4-super-admin-${++sequence}@example.com` });
    const login = await loginRequest({
      email: `dashboard-phase4-super-admin-${sequence}@example.com`,
      password: TEST_PASSWORD,
    });
    expect(login.status).toBe(200);
    const response = await getAnalytics(login.body.data.accessToken, 'request-analytics', {
      organizationId: tenant.organizationId.toString(),
    });
    expect(response.status).toBe(400);
    const platformResponse = await getAnalytics(login.body.data.accessToken, 'request-analytics');
    expect(platformResponse.status).toBe(200);
    expect(platformResponse.body.data.scope).toBe('PLATFORM');
    expect(platformResponse.body.data.requestTrends.some(({ count }) => count > 0)).toBe(true);
    expect(platformResponse.body.data.statusDistribution.find(({ status }) => status === 'APPROVED').count).toBe(1);
    expect(platformResponse.body.data.requestsByOrganization).toEqual([
      expect.objectContaining({
        organizationId: String(tenant.organizationId),
        organizationName: expect.any(String),
        totalRequests: 1,
        approvedRequests: 1,
      }),
    ]);
    expect(JSON.stringify(platformResponse.body.data)).not.toContain('Dashboard analytics request');
    expect(platformResponse.body.data.dateRange.timeZone).toBe('UTC');
  });

  it('serves aggregate platform organization, user, department, and allowlisted activity analytics', async () => {
    const tenant = await createContext({
      permissions: ['dashboard.view', 'requests.view'],
    });
    const secondOrganizationId = new mongoose.Types.ObjectId();
    await Organization.create({
      _id: secondOrganizationId,
      name: `Inactive platform analytics organization ${++sequence}`,
      status: 'INACTIVE',
      createdBy: tenant.user._id,
    });
    const secondDepartmentId = new mongoose.Types.ObjectId();
    await Department.create({
      _id: secondDepartmentId,
      organizationId: secondOrganizationId,
      name: `Platform analytics department ${sequence}`,
      status: 'ACTIVE',
    });
    const multiOrganizationUser = await createUser({
      name: 'Platform analytics multi-organization user',
      email: `platform-multi-org-${sequence}@example.com`,
      organizationMemberships: [
        { organizationId: tenant.organizationId, departmentId: tenant.departmentId, status: 'ACTIVE' },
        { organizationId: secondOrganizationId, departmentId: secondDepartmentId, status: 'INACTIVE' },
      ],
    });
    const extraRole = await Role.create({
      organizationId: tenant.organizationId,
      name: `Platform analytics second role ${sequence}`,
      permissions: ['dashboard.view'],
      status: 'ACTIVE',
      createdBy: tenant.user._id,
    });
    await UserRoleAssignment.create({
      userId: tenant.user._id,
      roleId: extraRole._id,
      organizationId: tenant.organizationId,
      departmentId: null,
      scopeType: 'ORGANIZATION',
      status: 'ACTIVE',
      assignedBy: tenant.user._id,
    });

    const pending = await createRequest({
      organizationId: tenant.organizationId,
      requesterId: tenant.user._id,
      departmentId: tenant.departmentId,
      status: 'PENDING_APPROVAL',
      requestTypeName: 'Purchase Request',
    });
    const approved = await createRequest({
      organizationId: secondOrganizationId,
      requesterId: multiOrganizationUser._id,
      departmentId: secondDepartmentId,
      status: 'APPROVED',
      requestTypeName: 'Equipment Request',
    });
    await RequestModel.updateOne({ _id: approved._id }, {
      $set: {
        description: 'Private request description must not be returned.',
        details: { secret: 'private request details' },
        amount: 98765,
      },
    });
    await AuditLog.create([
      {
        organizationId: secondOrganizationId,
        actorId: tenant.user._id,
        action: 'ORGANIZATION_UPDATED',
        resourceType: 'Organization',
        resourceId: secondOrganizationId,
        changes: { secret: 'private administrative payload' },
        timestamp: new Date(),
      },
      {
        organizationId: tenant.organizationId,
        actorId: tenant.user._id,
        action: 'ROLE_CREATED',
        resourceType: 'Role',
        resourceId: extraRole._id,
        timestamp: new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
      {
        organizationId: tenant.organizationId,
        actorId: tenant.user._id,
        action: 'ROLE_UPDATED',
        resourceType: 'Role',
        resourceId: extraRole._id,
        timestamp: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
      },
      {
        organizationId: secondOrganizationId,
        actorId: multiOrganizationUser._id,
        action: 'REQUEST_CREATED',
        resourceType: 'Request',
        resourceId: approved._id,
        changes: { description: 'private request audit content' },
        timestamp: new Date(),
      },
    ]);
    const adminEmail = `platform-analytics-admin-${++sequence}@example.com`;
    await createSuperAdmin({ email: adminEmail });
    const superAdminLogin = await loginRequest({ email: adminEmail, password: TEST_PASSWORD });
    const token = superAdminLogin.body.data.accessToken;

    const [organizations, users, departments, activity] = await Promise.all([
      getAnalytics(token, 'organization-analytics'),
      getAnalytics(token, 'user-analytics'),
      getAnalytics(token, 'department-analytics'),
      getAnalytics(token, 'recent-activity'),
    ]);

    expect(organizations.status).toBe(200);
    expect(organizations.body.data).toMatchObject({
      scope: 'PLATFORM',
      organizationComparison: {
        currentPeriodCount: 2,
        previousPeriodCount: 0,
        absoluteDifference: 2,
        percentageChange: null,
      },
    });
    expect(organizations.body.data.statusDistribution).toEqual([
      { status: 'ACTIVE', count: 1 },
      { status: 'INACTIVE', count: 1 },
    ]);
    expect(organizations.body.data.organizations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        organizationId: String(tenant.organizationId),
        totalMemberships: 2,
        activeMemberships: 2,
        totalRequests: 1,
        periodRequests: 1,
      }),
      expect.objectContaining({
        organizationId: String(secondOrganizationId),
        totalMemberships: 1,
        inactiveMemberships: 1,
        totalDepartments: 1,
        totalRequests: 1,
      }),
    ]));

    expect(users.status).toBe(200);
    expect(users.body.data.userCounts).toMatchObject({
      totalUniqueUsers: 3,
      activeUniqueUsers: 3,
      inactiveUniqueUsers: 0,
      activeUserBasis: 'USER_ACCOUNT_STATUS',
    });
    expect(users.body.data.membershipCounts).toMatchObject({
      total: 3,
      active: 2,
      inactive: 1,
      basis: 'ORGANIZATION_MEMBERSHIPS',
    });
    expect(users.body.data.byRoleCategory).toEqual(expect.arrayContaining([
      expect.objectContaining({
        roleCategory: 'CUSTOM',
        uniqueUsers: 1,
        metricBasis: 'UNIQUE_ACTIVE_USERS_WITH_ACTIVE_ASSIGNMENT',
      }),
    ]));

    expect(departments.status).toBe(200);
    expect(departments.body.data.totalDepartments).toBe(2);
    expect(departments.body.data.byOrganization).toHaveLength(2);
    expect(departments.body.data.departmentGrowth.some(({ count }) => count > 0)).toBe(true);

    expect(activity.status).toBe(200);
    expect(activity.body.data.scope).toBe('PLATFORM');
    expect(activity.body.data.items).toHaveLength(2);
    expect(activity.body.data.items[0]).toMatchObject({
      action: 'ORGANIZATION_UPDATED',
      target: { type: 'Organization', id: String(secondOrganizationId) },
    });
    expect(activity.body.data.items[1].action).toBe('ROLE_CREATED');
    expect(new Date(activity.body.data.items[0].timestamp).getTime())
      .toBeGreaterThan(new Date(activity.body.data.items[1].timestamp).getTime());
    const firstActivityPage = await getAnalytics(token, 'recent-activity', { page: '1', limit: '1' });
    const secondActivityPage = await getAnalytics(token, 'recent-activity', { page: '2', limit: '1' });
    expect(firstActivityPage.body.data.pagination).toMatchObject({ page: 1, limit: 1, total: 2, totalPages: 2 });
    expect(secondActivityPage.body.data.pagination).toMatchObject({ page: 2, limit: 1, total: 2, totalPages: 2 });
    expect(firstActivityPage.body.data.items[0].activityId)
      .not.toBe(secondActivityPage.body.data.items[0].activityId);
    const serialized = JSON.stringify({
      organizations: organizations.body.data,
      users: users.body.data,
      departments: departments.body.data,
      activity: activity.body.data,
    });
    expect(serialized).not.toContain('Private request description');
    expect(serialized).not.toContain('private request details');
    expect(serialized).not.toContain('private administrative payload');
    expect(serialized).not.toContain(String(approved._id));
    expect(serialized).not.toContain(String(pending._id));
  });

  it('keeps platform-only analytics and approval analytics outside tenant authorization', async () => {
    const tenant = await createContext({
      permissions: ['dashboard.view', 'requests.view'],
      roleType: 'ORGANIZATION_ADMIN',
    });
    const [organizations, users, approval, forgedPlatformScope] = await Promise.all([
      getAnalytics(tenant.token, 'organization-analytics'),
      getAnalytics(tenant.token, 'user-analytics'),
      getAnalytics(tenant.token, 'approval-analytics'),
      getAnalytics(tenant.token, 'request-analytics', {
        organizationId: new mongoose.Types.ObjectId().toString(),
      }),
    ]);
    expect(organizations.status).toBe(403);
    expect(users.status).toBe(403);
    expect(approval.status).toBe(403);
    expect(forgedPlatformScope.status).toBe(400);
  });

  it('does not treat Finance role purpose as an approval permission grant', async () => {
    const context = await createContext({
      permissions: ['dashboard.view'],
      rolePurpose: 'FINANCE_APPROVER',
    });
    const response = await getAnalytics(context.token, 'approval-analytics');
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FORBIDDEN');
  });

  it('creates and updates explicit role purpose without changing role permissions', async () => {
    const context = await createContext({
      permissions: ['dashboard.view', 'roles.create', 'roles.edit'],
      roleType: 'ORGANIZATION_ADMIN',
    });
    const created = await request(app)
      .post('/api/roles')
      .set(authHeader(context.token))
      .send({ name: 'Finance reporting role', permissions: ['dashboard.view'] });
    expect(created.status).toBe(201);
    expect(created.body.data.rolePurpose).toBe('GENERAL');
    expect(created.body.data.permissions).toEqual(['dashboard.view']);

    const updated = await request(app)
      .patch(`/api/roles/${created.body.data.id}`)
      .set(authHeader(context.token))
      .send({ rolePurpose: 'FINANCE_APPROVER' });
    expect(updated.status).toBe(200);
    expect(updated.body.data.rolePurpose).toBe('FINANCE_APPROVER');
    expect(updated.body.data.permissions).toEqual(['dashboard.view']);

    const invalid = await request(app)
      .patch(`/api/roles/${created.body.data.id}`)
      .set(authHeader(context.token))
      .send({ rolePurpose: 'PAYMENTS_ADMIN' });
    expect(invalid.status).toBe(400);

    const builtIn = await Role.create({
      organizationId: context.organizationId,
      name: 'Built-in employee',
      roleType: 'EMPLOYEE',
      permissions: [],
      createdBy: context.user._id,
    });
    const protectedUpdate = await request(app)
      .patch(`/api/roles/${builtIn._id}`)
      .set(authHeader(context.token))
      .send({ rolePurpose: 'FINANCE_APPROVER' });
    expect(protectedUpdate.status).toBe(409);
    expect(protectedUpdate.body.code).toBe('BUILT_IN_ROLE_PROTECTED');
  });

  it('requires existing role-management authorization to create a role purpose', async () => {
    const context = await createContext({
      permissions: ['dashboard.view'],
    });
    const response = await request(app)
      .post('/api/roles')
      .set(authHeader(context.token))
      .send({
        name: 'Unauthorized finance role',
        permissions: ['dashboard.view'],
        rolePurpose: 'FINANCE_APPROVER',
      });
    expect(response.status).toBe(403);
  });

  it('keeps approval activity available only for assignments inside the authorized department', async () => {
    const context = await createContext({
      permissions: ['dashboard.view', 'requests.approve'],
      scope: 'DEPARTMENT',
      roleType: 'DEPARTMENT_MANAGER',
    });
    const requester = await createUser({
      name: 'Inbox activity requester',
      email: `dashboard-analytics-inbox-${++sequence}@example.com`,
      organizationMemberships: [{
        organizationId: context.organizationId,
        departmentId: context.departmentId,
        status: 'ACTIVE',
      }],
    });
    const assignedRequest = await createRequest({
      organizationId: context.organizationId,
      requesterId: requester._id,
      departmentId: context.departmentId,
      status: 'PENDING_APPROVAL',
    });
    const unrelatedDepartmentId = new mongoose.Types.ObjectId();
    await Department.create({
      _id: unrelatedDepartmentId,
      organizationId: context.organizationId,
      name: `Unrelated dashboard department ${sequence}`,
      status: 'ACTIVE',
    });
    const unrelatedRequest = await createRequest({
      organizationId: context.organizationId,
      requesterId: requester._id,
      departmentId: unrelatedDepartmentId,
      status: 'PENDING_APPROVAL',
    });
    const assignedStep = await createStep({
      organizationId: context.organizationId,
      requestId: assignedRequest._id,
      approverId: context.user._id,
      roleId: context.role._id,
      status: 'CLAIMED',
      claimedBy: context.user._id,
    });
    const unrelatedStep = await createStep({
      organizationId: context.organizationId,
      requestId: unrelatedRequest._id,
      approverId: context.user._id,
      roleId: context.role._id,
      stageId: 'unrelated-stage',
    });
    await AuditLog.create([
      {
        organizationId: context.organizationId,
        actorId: context.user._id,
        action: 'APPROVAL_CLAIMED',
        resourceType: 'Approval',
        resourceId: assignedStep._id,
        timestamp: new Date(),
      },
      {
        organizationId: context.organizationId,
        actorId: context.user._id,
        action: 'APPROVAL_CLAIMED',
        resourceType: 'Approval',
        resourceId: unrelatedStep._id,
        timestamp: new Date(),
      },
    ]);

    const response = await getAnalytics(context.token, 'recent-activity');
    expect(response.status).toBe(200);
    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0].requestId).toBe(String(assignedRequest._id));
  });
});
