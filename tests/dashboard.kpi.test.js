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
import Department from '../src/models/Department.js';
import Organization from '../src/models/Organization.js';
import RequestModel from '../src/models/Request.js';
import Role from '../src/models/Role.js';
import User from '../src/models/User.js';
import UserRoleAssignment from '../src/models/UserRoleAssignment.js';

const authHeader = (token) => ({ Authorization: `Bearer ${token}` });
let sequence = 0;

const createContext = async ({ permissions, scope = 'ORGANIZATION', departmentCount = 1, roleType = 'CUSTOM' }) => {
  const suffix = ++sequence;
  const organizationId = new mongoose.Types.ObjectId();
  const departmentIds = Array.from({ length: departmentCount }, () => new mongoose.Types.ObjectId());
  const user = await createUser({
    name: `Dashboard KPI User ${suffix}`,
    email: `dashboard-kpi-${suffix}@example.com`,
    organizationMemberships: [{
      organizationId,
      departmentId: scope === 'DEPARTMENT' ? departmentIds[0] : null,
      status: 'ACTIVE',
    }],
  });
  await Organization.create({
    _id: organizationId,
    name: `Dashboard KPI Organization ${suffix}`,
    status: 'ACTIVE',
    createdBy: user._id,
  });
  await Department.create(departmentIds.map((departmentId, index) => ({
    _id: departmentId,
    organizationId,
    name: `Dashboard KPI Department ${suffix}-${index}`,
    status: 'ACTIVE',
  })));

  const role = await Role.create({
    organizationId,
    name: `Dashboard KPI Role ${suffix}`,
    roleType,
    permissions,
    status: 'ACTIVE',
    createdBy: user._id,
  });
  await UserRoleAssignment.create({
    userId: user._id,
    roleId: role._id,
    organizationId,
    departmentId: scope === 'DEPARTMENT' ? departmentIds[0] : null,
    scopeType: scope,
    status: 'ACTIVE',
    assignedBy: user._id,
  });
  const login = await loginRequest({ email: user.email, password: TEST_PASSWORD });
  expect(login.status).toBe(200);
  return { user, role, organizationId, departmentIds, token: login.body.data.accessToken };
};

const createRequest = async ({
  organizationId,
  requesterId,
  departmentId,
  status = 'DRAFT',
  amount = null,
  createdAt = new Date(),
  suffix = ++sequence,
}) => RequestModel.create({
  organizationId,
  requesterId,
  requestNumber: `DASH-${String(suffix).padStart(6, '0')}`,
  departmentId,
  requestType: 'PURCHASE',
  title: `Dashboard request ${suffix}`,
  details: {},
  amount,
  status,
  currentSequence: status === 'PENDING_APPROVAL' ? 1 : 0,
  createdAt,
  updatedAt: createdAt,
});

const createApprovalStep = async ({
  organizationId,
  requestId,
  approverId,
  roleId,
  status = 'ACTIVE',
  stageId = 'approval-stage',
  sequenceNumber = 1,
  attemptNumber = 1,
  assignmentResolution = 'CLAIM_ONE',
  claimedBy = null,
  decidedBy = null,
  decisionAt = null,
  isOverdue = false,
  claimExpiresAt = null,
  actedOnBehalfOf = null,
}) => ApprovalStep.create({
  organizationId,
  requestId,
  attemptNumber,
  workflowDefinitionId: new mongoose.Types.ObjectId(),
  workflowVersion: 1,
  stageId,
  sequence: sequenceNumber,
  stageName: 'Approval Stage',
  approverType: 'ROLE',
  assignmentResolution,
  approvalMode: 'ANY',
  approverId,
  roleId,
  claimedBy,
  decidedBy,
  decisionAt,
  status,
  isOverdue,
  claimExpiresAt,
  actedOnBehalfOf,
});

const getSummary = (token, query = {}) =>
  request(app).get('/api/dashboard/summary').set(authHeader(token)).query(query);

const valueFor = (response, key) =>
  response.body.data.kpis.find((item) => item.key === key)?.value;

describe('Dashboard KPI summary API', () => {
  beforeAll(async () => {
    await connectTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await disconnectTestDatabase();
  });

  it('returns personal request counts only for the authenticated requester', async () => {
    const context = await createContext({
      permissions: ['dashboard.view', 'requests.view', 'requests.create'],
      roleType: 'EMPLOYEE',
    });
    const other = await createUser({
      name: 'Another requester',
      email: `another-requester-${++sequence}@example.com`,
      organizationMemberships: [{
        organizationId: context.organizationId,
        departmentId: context.departmentIds[0],
        status: 'ACTIVE',
      }],
    });
    for (const status of ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'RETURNED']) {
      await createRequest({
        organizationId: context.organizationId,
        requesterId: context.user._id,
        departmentId: context.departmentIds[0],
        status,
      });
    }
    await createRequest({
      organizationId: context.organizationId,
      requesterId: other._id,
      departmentId: context.departmentIds[0],
      status: 'APPROVED',
    });
    const foreignOrganizationId = new mongoose.Types.ObjectId();
    await Organization.create({
      _id: foreignOrganizationId,
      name: `Foreign dashboard organization ${sequence}`,
      status: 'ACTIVE',
      createdBy: context.user._id,
    });
    await createRequest({
      organizationId: foreignOrganizationId,
      requesterId: context.user._id,
      departmentId: new mongoose.Types.ObjectId(),
      status: 'APPROVED',
    });

    const response = await getSummary(context.token);
    expect(response.status).toBe(200);
    expect(valueFor(response, 'MY_TOTAL_REQUESTS')).toBe(5);
    expect(valueFor(response, 'MY_DRAFT_REQUESTS')).toBe(1);
    expect(valueFor(response, 'MY_PENDING_REQUESTS')).toBe(1);
    expect(valueFor(response, 'MY_APPROVED_REQUESTS')).toBe(1);
    expect(valueFor(response, 'MY_REJECTED_REQUESTS')).toBe(1);
    expect(valueFor(response, 'MY_RETURNED_REQUESTS')).toBe(1);
  });

  it('filters personal request counts by the selected creation date range', async () => {
    const context = await createContext({
      permissions: ['dashboard.view', 'requests.view'],
      roleType: 'EMPLOYEE',
    });
    await createRequest({
      organizationId: context.organizationId,
      requesterId: context.user._id,
      departmentId: context.departmentIds[0],
      createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    });
    await createRequest({
      organizationId: context.organizationId,
      requesterId: context.user._id,
      departmentId: context.departmentIds[0],
      createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
    });

    const response = await getSummary(context.token, { range: 'LAST_7_DAYS' });
    expect(response.status).toBe(200);
    expect(valueFor(response, 'MY_TOTAL_REQUESTS')).toBe(1);
    expect(response.body.data.dateRange.range).toBe('LAST_7_DAYS');
  });

  it('limits custom request and role KPIs to the assigned department scope', async () => {
    const context = await createContext({
      permissions: ['dashboard.view', 'requests.view', 'roles.view'],
      scope: 'DEPARTMENT',
      departmentCount: 2,
    });
    const otherRequester = await createUser({
      name: 'Custom KPI requester',
      email: `custom-kpi-requester-${++sequence}@example.com`,
    });
    await createRequest({
      organizationId: context.organizationId,
      requesterId: otherRequester._id,
      departmentId: context.departmentIds[0],
      status: 'APPROVED',
    });
    await createRequest({
      organizationId: context.organizationId,
      requesterId: otherRequester._id,
      departmentId: context.departmentIds[1],
      status: 'REJECTED',
    });

    const response = await getSummary(context.token);
    expect(response.status).toBe(200);
    expect(valueFor(response, 'ACCESSIBLE_REQUESTS')).toBe(1);
    expect(valueFor(response, 'ACCESSIBLE_APPROVED_REQUESTS')).toBe(1);
    expect(valueFor(response, 'ACCESSIBLE_REJECTED_REQUESTS')).toBe(0);
    expect(valueFor(response, 'TOTAL_ROLES')).toBeUndefined();
  });

  it('returns zeros for empty request and approval metrics', async () => {
    const context = await createContext({
      permissions: ['dashboard.view', 'requests.view', 'requests.approve'],
      roleType: 'EMPLOYEE',
    });
    const response = await getSummary(context.token);
    expect(response.status).toBe(200);
    expect(valueFor(response, 'MY_TOTAL_REQUESTS')).toBe(0);
    expect(valueFor(response, 'PENDING_MY_APPROVAL')).toBe(0);
    expect(valueFor(response, 'APPROVED_BY_ME')).toBe(0);
  });

  it('separates personal manager requests from approval workload and deduplicates CLAIM_ONE stages', async () => {
    const context = await createContext({
      permissions: ['dashboard.view', 'requests.view', 'requests.approve'],
      scope: 'DEPARTMENT',
      roleType: 'DEPARTMENT_MANAGER',
    });
    const employee = await createUser({
      name: 'Assigned employee',
      email: `assigned-employee-${++sequence}@example.com`,
      organizationMemberships: [{
        organizationId: context.organizationId,
        departmentId: context.departmentIds[0],
        status: 'ACTIVE',
      }],
    });
    const requestDoc = await createRequest({
      organizationId: context.organizationId,
      requesterId: employee._id,
      departmentId: context.departmentIds[0],
      status: 'PENDING_APPROVAL',
      amount: 700,
    });
    await createApprovalStep({
      organizationId: context.organizationId,
      requestId: requestDoc._id,
      approverId: context.user._id,
      roleId: context.role._id,
      isOverdue: true,
    });
    await createApprovalStep({
      organizationId: context.organizationId,
      requestId: requestDoc._id,
      approverId: new mongoose.Types.ObjectId(),
      roleId: context.role._id,
      status: 'ACTIVE',
    });

    const response = await getSummary(context.token);
    expect(response.status).toBe(200);
    expect(valueFor(response, 'MY_TOTAL_REQUESTS')).toBe(0);
    expect(valueFor(response, 'PENDING_MY_APPROVAL')).toBe(1);
    expect(valueFor(response, 'AVAILABLE_TO_CLAIM')).toBe(1);
    expect(valueFor(response, 'OVERDUE_APPROVALS')).toBe(1);
  });

  it('does not count a CLAIM_ONE stage that another approver has claimed', async () => {
    const context = await createContext({
      permissions: ['dashboard.view', 'requests.approve'],
      scope: 'DEPARTMENT',
    });
    const requester = await createUser({
      name: 'Claimed request owner',
      email: `claimed-owner-${++sequence}@example.com`,
      organizationMemberships: [{
        organizationId: context.organizationId,
        departmentId: context.departmentIds[0],
        status: 'ACTIVE',
      }],
    });
    const requestDoc = await createRequest({
      organizationId: context.organizationId,
      requesterId: requester._id,
      departmentId: context.departmentIds[0],
      status: 'PENDING_APPROVAL',
    });
    await createApprovalStep({
      organizationId: context.organizationId,
      requestId: requestDoc._id,
      approverId: context.user._id,
      roleId: context.role._id,
    });
    await createApprovalStep({
      organizationId: context.organizationId,
      requestId: requestDoc._id,
      approverId: new mongoose.Types.ObjectId(),
      roleId: context.role._id,
      status: 'CLAIMED',
      claimedBy: new mongoose.Types.ObjectId(),
    });

    const response = await getSummary(context.token);
    expect(valueFor(response, 'AVAILABLE_TO_CLAIM')).toBe(0);
    expect(valueFor(response, 'PENDING_MY_APPROVAL')).toBe(0);
  });

  it('counts only approval work within active department permission scope', async () => {
    const context = await createContext({
      permissions: ['dashboard.view', 'requests.approve'],
      scope: 'DEPARTMENT',
      departmentCount: 2,
    });
    for (const departmentId of context.departmentIds) {
      const requester = await createUser({
        name: `Scoped requester ${++sequence}`,
        email: `scoped-requester-${sequence}@example.com`,
        organizationMemberships: [{
          organizationId: context.organizationId,
          departmentId,
          status: 'ACTIVE',
        }],
      });
      const requestDoc = await createRequest({
        organizationId: context.organizationId,
        requesterId: requester._id,
        departmentId,
        status: 'PENDING_APPROVAL',
      });
      await createApprovalStep({
        organizationId: context.organizationId,
        requestId: requestDoc._id,
        approverId: context.user._id,
        roleId: context.role._id,
      });
    }

    const response = await getSummary(context.token);
    expect(valueFor(response, 'PENDING_MY_APPROVAL')).toBe(1);
    expect(valueFor(response, 'AVAILABLE_TO_CLAIM')).toBe(1);
  });

  it('combines multiple custom roles without duplicating approval KPI cards', async () => {
    const context = await createContext({
      permissions: ['dashboard.view', 'requests.approve'],
      scope: 'DEPARTMENT',
    });
    const secondRole = await Role.create({
      organizationId: context.organizationId,
      name: `Second dashboard KPI role ${sequence}`,
      permissions: ['requests.approve'],
      status: 'ACTIVE',
      createdBy: context.user._id,
    });
    await UserRoleAssignment.create({
      userId: context.user._id,
      roleId: secondRole._id,
      organizationId: context.organizationId,
      departmentId: context.departmentIds[0],
      scopeType: 'DEPARTMENT',
      status: 'ACTIVE',
      assignedBy: context.user._id,
    });
    const requester = await createUser({
      name: 'Multi-role requester',
      email: `multi-role-requester-${++sequence}@example.com`,
      organizationMemberships: [{
        organizationId: context.organizationId,
        departmentId: context.departmentIds[0],
        status: 'ACTIVE',
      }],
    });
    const requestDoc = await createRequest({
      organizationId: context.organizationId,
      requesterId: requester._id,
      departmentId: context.departmentIds[0],
      status: 'PENDING_APPROVAL',
    });
    await createApprovalStep({
      organizationId: context.organizationId,
      requestId: requestDoc._id,
      approverId: context.user._id,
      roleId: context.role._id,
    });

    const response = await getSummary(context.token);
    const keys = response.body.data.kpis.map(({ key }) => key);
    expect(keys.filter((key) => key === 'PENDING_MY_APPROVAL')).toHaveLength(1);
    expect(valueFor(response, 'PENDING_MY_APPROVAL')).toBe(1);
  });

  it('does not expose approval KPI cards without effective requests.approve permission', async () => {
    const context = await createContext({
      permissions: ['dashboard.view', 'requests.view'],
    });
    const response = await getSummary(context.token);
    expect(response.status).toBe(200);
    expect(response.body.data.kpis.some(({ key }) => key === 'PENDING_MY_APPROVAL')).toBe(false);
  });

  it('limits department user and department metrics to assigned department scopes', async () => {
    const context = await createContext({
      permissions: ['dashboard.view', 'users.view', 'departments.view'],
      scope: 'DEPARTMENT',
      departmentCount: 2,
    });
    const otherDepartmentUser = await createUser({
      name: 'Other department user',
      email: `other-department-user-${++sequence}@example.com`,
      organizationMemberships: [{
        organizationId: context.organizationId,
        departmentId: context.departmentIds[1],
        status: 'ACTIVE',
      }],
    });
    const response = await getSummary(context.token);
    expect(response.status).toBe(200);
    expect(valueFor(response, 'TOTAL_EMPLOYEES')).toBe(1);
    expect(valueFor(response, 'TOTAL_DEPARTMENTS')).toBe(1);
    expect(await User.countDocuments({ _id: otherDepartmentUser._id })).toBe(1);
  });

  it('counts personal approval decisions by decision time and sums each approved request once', async () => {
    const context = await createContext({
      permissions: ['dashboard.view', 'requests.approve'],
      scope: 'DEPARTMENT',
      roleType: 'FINANCE_APPROVER',
    });
    const requester = await createUser({
      name: 'Approval decision requester',
      email: `decision-requester-${++sequence}@example.com`,
      organizationMemberships: [{
        organizationId: context.organizationId,
        departmentId: context.departmentIds[0],
        status: 'ACTIVE',
      }],
    });
    const approvedRequest = await createRequest({
      organizationId: context.organizationId,
      requesterId: requester._id,
      departmentId: context.departmentIds[0],
      status: 'APPROVED',
      amount: 500,
    });
    const rejectedRequest = await createRequest({
      organizationId: context.organizationId,
      requesterId: requester._id,
      departmentId: context.departmentIds[0],
      status: 'REJECTED',
    });
    const returnedRequest = await createRequest({
      organizationId: context.organizationId,
      requesterId: requester._id,
      departmentId: context.departmentIds[0],
      status: 'RETURNED',
    });
    for (const [requestDoc, status] of [
      [approvedRequest, 'APPROVED'],
      [rejectedRequest, 'REJECTED'],
      [returnedRequest, 'RETURNED'],
    ]) {
      await createApprovalStep({
        organizationId: context.organizationId,
        requestId: requestDoc._id,
        approverId: context.user._id,
        roleId: context.role._id,
        status,
        decidedBy: context.user._id,
        decisionAt: new Date(),
      });
    }
    await createApprovalStep({
      organizationId: context.organizationId,
      requestId: approvedRequest._id,
      approverId: context.user._id,
      roleId: context.role._id,
      status: 'APPROVED',
      decidedBy: context.user._id,
      decisionAt: new Date(),
      stageId: 'second-approved-stage',
      sequenceNumber: 2,
    });

    const response = await getSummary(context.token);
    expect(valueFor(response, 'APPROVED_BY_ME')).toBe(2);
    expect(valueFor(response, 'REJECTED_BY_ME')).toBe(1);
    expect(valueFor(response, 'RETURNED_BY_ME')).toBe(1);
    expect(valueFor(response, 'TOTAL_APPROVED_AMOUNT')).toBe(500);
  });

  it('does not present a finance amount KPI for an unrelated custom approver role', async () => {
    const context = await createContext({
      permissions: ['dashboard.view', 'requests.approve'],
      scope: 'DEPARTMENT',
      roleType: 'CUSTOM',
    });
    const requester = await createUser({
      name: 'Custom approver requester',
      email: `custom-approver-requester-${++sequence}@example.com`,
      organizationMemberships: [{
        organizationId: context.organizationId,
        departmentId: context.departmentIds[0],
        status: 'ACTIVE',
      }],
    });
    const requestDoc = await createRequest({
      organizationId: context.organizationId,
      requesterId: requester._id,
      departmentId: context.departmentIds[0],
      status: 'APPROVED',
      amount: 900,
    });
    await createApprovalStep({
      organizationId: context.organizationId,
      requestId: requestDoc._id,
      approverId: context.user._id,
      roleId: context.role._id,
      status: 'APPROVED',
      decidedBy: context.user._id,
      decisionAt: new Date(),
    });

    const response = await getSummary(context.token);
    expect(response.status).toBe(200);
    expect(valueFor(response, 'APPROVED_BY_ME')).toBe(1);
    expect(valueFor(response, 'TOTAL_APPROVED_AMOUNT')).toBeUndefined();
  });

  it('excludes expired and stage-restricted delegations from approval workload', async () => {
    const context = await createContext({
      permissions: ['dashboard.view', 'requests.approve'],
      scope: 'DEPARTMENT',
    });
    const now = new Date();
    const delegator = await createUser({
      name: 'Delegator',
      email: `delegator-${++sequence}@example.com`,
      organizationMemberships: [{
        organizationId: context.organizationId,
        departmentId: context.departmentIds[0],
        status: 'ACTIVE',
      }],
    });
    await User.updateOne({ _id: delegator._id }, {
      $set: {
        approvalDelegations: [
          {
            organizationId: context.organizationId,
            delegateId: context.user._id,
            scopeType: 'DEPARTMENT',
            departmentId: context.departmentIds[0],
            stageIds: ['allowed-stage'],
            startsAt: new Date(now.getTime() - 60_000),
            endsAt: new Date(now.getTime() + 60_000),
            status: 'ACTIVE',
          },
          {
            organizationId: context.organizationId,
            delegateId: context.user._id,
            scopeType: 'DEPARTMENT',
            departmentId: context.departmentIds[0],
            stageIds: [],
            startsAt: new Date(now.getTime() - 120_000),
            endsAt: new Date(now.getTime() - 60_000),
            status: 'ACTIVE',
          },
        ],
      },
    });
    for (const [stageId, suffix] of [['restricted-stage', 'restricted'], ['expired-stage', 'expired']]) {
      const requester = await createUser({
        name: `Delegated requester ${suffix}`,
        email: `delegated-requester-${suffix}-${++sequence}@example.com`,
        organizationMemberships: [{
          organizationId: context.organizationId,
          departmentId: context.departmentIds[0],
          status: 'ACTIVE',
        }],
      });
      const requestDoc = await createRequest({
        organizationId: context.organizationId,
        requesterId: requester._id,
        departmentId: context.departmentIds[0],
        status: 'PENDING_APPROVAL',
      });
      await createApprovalStep({
        organizationId: context.organizationId,
        requestId: requestDoc._id,
        approverId: delegator._id,
        roleId: context.role._id,
        stageId,
      });
    }

    const response = await getSummary(context.token);
    expect(valueFor(response, 'PENDING_MY_APPROVAL')).toBe(0);
    expect(valueFor(response, 'AVAILABLE_TO_CLAIM')).toBe(0);
  });

  it('provides organization metrics only from the organization-admin assignment scope', async () => {
    const context = await createContext({
      roleType: 'ORGANIZATION_ADMIN',
      permissions: [
        'dashboard.view',
        'requests.view',
        'users.view',
        'departments.view',
        'roles.view',
      ],
    });
    const ownRequest = await createRequest({
      organizationId: context.organizationId,
      requesterId: context.user._id,
      departmentId: context.departmentIds[0],
      status: 'APPROVED',
    });
    const foreignOrganization = new mongoose.Types.ObjectId();
    await Organization.create({
      _id: foreignOrganization,
      name: `Foreign KPI organization ${sequence}`,
      status: 'ACTIVE',
      createdBy: context.user._id,
    });
    await createRequest({
      organizationId: foreignOrganization,
      requesterId: context.user._id,
      departmentId: new mongoose.Types.ObjectId(),
      status: 'REJECTED',
    });
    const extraRole = await Role.create({
      organizationId: context.organizationId,
      name: `Duplicate role ${sequence}`,
      permissions: ['users.view'],
      status: 'ACTIVE',
      createdBy: context.user._id,
    });
    await UserRoleAssignment.create({
      userId: context.user._id,
      roleId: extraRole._id,
      organizationId: context.organizationId,
      scopeType: 'ORGANIZATION',
      departmentId: null,
      status: 'ACTIVE',
      assignedBy: context.user._id,
    });

    const response = await getSummary(context.token);
    expect(valueFor(response, 'TOTAL_REQUESTS')).toBe(1);
    expect(valueFor(response, 'APPROVED_REQUESTS')).toBe(1);
    expect(valueFor(response, 'REJECTED_REQUESTS')).toBe(0);
    expect(valueFor(response, 'TOTAL_EMPLOYEES')).toBe(1);
    expect(valueFor(response, 'TOTAL_DEPARTMENTS')).toBe(1);
    expect(valueFor(response, 'TOTAL_ROLES')).toBe(2);
    expect(valueFor(response, 'BUILT_IN_ROLES')).toBe(1);
    expect(valueFor(response, 'CUSTOM_ROLES')).toBe(1);
    expect(valueFor(response, 'ACTIVE_ROLE_ASSIGNMENTS')).toBe(2);
    expect(String(ownRequest.organizationId)).toBe(String(context.organizationId));
  });

  it('returns platform counts without tenant request KPIs for Super Admin', async () => {
    const context = await createContext({
      permissions: ['dashboard.view', 'requests.view'],
    });
    await createRequest({
      organizationId: context.organizationId,
      requesterId: context.user._id,
      departmentId: context.departmentIds[0],
      status: 'APPROVED',
    });
    await createSuperAdmin({ email: 'dashboard-kpi-super-admin@example.com' });
    const login = await loginRequest({
      email: 'dashboard-kpi-super-admin@example.com',
      password: TEST_PASSWORD,
    });
    const response = await getSummary(login.body.data.accessToken);
    expect(response.status).toBe(200);
    expect(response.body.data.dashboardType).toBe('PLATFORM');
    expect(response.body.data.kpis.map(({ key }) => key)).toEqual([
      'TOTAL_ORGANIZATIONS',
      'ACTIVE_ORGANIZATIONS',
      'INACTIVE_ORGANIZATIONS',
      'NEW_ORGANIZATIONS',
      'TOTAL_USERS',
      'ACTIVE_USERS',
      'INACTIVE_USERS',
      'TOTAL_ORGANIZATION_MEMBERSHIPS',
      'ACTIVE_ORGANIZATION_MEMBERSHIPS',
      'INACTIVE_ORGANIZATION_MEMBERSHIPS',
      'TOTAL_DEPARTMENTS',
      'TOTAL_REQUESTS',
      'PENDING_REQUESTS',
      'APPROVED_REQUESTS',
      'REJECTED_REQUESTS',
      'RETURNED_REQUESTS',
      'CANCELLED_REQUESTS',
    ]);
    expect(valueFor(response, 'TOTAL_ORGANIZATIONS')).toBe(1);
    expect(valueFor(response, 'NEW_ORGANIZATIONS')).toBe(1);
    expect(valueFor(response, 'TOTAL_USERS')).toBe(2);
    expect(valueFor(response, 'ACTIVE_USERS')).toBe(2);
    expect(valueFor(response, 'INACTIVE_USERS')).toBe(0);
    expect(valueFor(response, 'TOTAL_ORGANIZATION_MEMBERSHIPS')).toBe(1);
    expect(valueFor(response, 'ACTIVE_ORGANIZATION_MEMBERSHIPS')).toBe(1);
    expect(valueFor(response, 'INACTIVE_ORGANIZATION_MEMBERSHIPS')).toBe(0);
    expect(valueFor(response, 'TOTAL_DEPARTMENTS')).toBe(1);
    expect(valueFor(response, 'TOTAL_REQUESTS')).toBe(1);
    expect(valueFor(response, 'APPROVED_REQUESTS')).toBe(1);
    expect(valueFor(response, 'PENDING_REQUESTS')).toBe(0);
  });

  it('counts unique platform users and organization memberships independently of role assignments', async () => {
    const context = await createContext({
      permissions: ['dashboard.view'],
    });
    const secondOrganizationId = new mongoose.Types.ObjectId();
    await Organization.create({
      _id: secondOrganizationId,
      name: `Second KPI organization ${sequence}`,
      status: 'INACTIVE',
      createdBy: context.user._id,
    });
    context.user.organizationMemberships.push({
      membershipId: new mongoose.Types.ObjectId(),
      organizationId: secondOrganizationId,
      departmentId: null,
      status: 'INACTIVE',
    });
    await context.user.save();

    const secondRole = await Role.create({
      organizationId: context.organizationId,
      name: `Second KPI role ${sequence}`,
      permissions: ['dashboard.view'],
      status: 'ACTIVE',
      createdBy: context.user._id,
    });
    await UserRoleAssignment.create({
      userId: context.user._id,
      roleId: secondRole._id,
      organizationId: context.organizationId,
      departmentId: null,
      scopeType: 'ORGANIZATION',
      status: 'ACTIVE',
      assignedBy: context.user._id,
    });
    const inactiveUser = await createUser({
      name: 'Inactive KPI user',
      email: `inactive-kpi-${++sequence}@example.com`,
      accountStatus: 'INACTIVE',
      organizationMemberships: [
        { organizationId: context.organizationId, departmentId: null, status: 'ACTIVE' },
        { organizationId: secondOrganizationId, departmentId: null, status: 'INACTIVE' },
      ],
    });
    await createSuperAdmin({ email: `membership-kpi-admin-${++sequence}@example.com` });
    const adminEmail = `membership-kpi-admin-${sequence}@example.com`;
    const login = await loginRequest({ email: adminEmail, password: TEST_PASSWORD });
    const response = await getSummary(login.body.data.accessToken);

    expect(response.status).toBe(200);
    expect(valueFor(response, 'TOTAL_USERS')).toBe(3);
    expect(valueFor(response, 'ACTIVE_USERS')).toBe(2);
    expect(valueFor(response, 'INACTIVE_USERS')).toBe(1);
    expect(valueFor(response, 'TOTAL_ORGANIZATION_MEMBERSHIPS')).toBe(4);
    expect(valueFor(response, 'ACTIVE_ORGANIZATION_MEMBERSHIPS')).toBe(2);
    expect(valueFor(response, 'INACTIVE_ORGANIZATION_MEMBERSHIPS')).toBe(2);
    expect(await UserRoleAssignment.countDocuments({ userId: context.user._id })).toBe(2);
    expect(await User.findById(inactiveUser._id)).toBeTruthy();
  });

  it('rejects invalid date ranges and does not accept client-selected authorization scope', async () => {
    const context = await createContext({
      permissions: ['dashboard.view', 'requests.view'],
    });
    const invalidRange = await getSummary(context.token, { range: 'NOT_A_PRESET' });
    const forgedScope = await getSummary(context.token, {
      range: 'LAST_7_DAYS',
      organizationId: new mongoose.Types.ObjectId().toString(),
    });
    expect(invalidRange.status).toBe(400);
    expect(forgedScope.status).toBe(400);
  });
});
