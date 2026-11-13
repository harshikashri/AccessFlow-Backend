import mongoose from 'mongoose';
import ApprovalStep from '../../models/ApprovalStep.js';
import Department from '../../models/Department.js';
import Organization from '../../models/Organization.js';
import Request from '../../models/Request.js';
import Role from '../../models/Role.js';
import User from '../../models/User.js';
import UserRoleAssignment from '../../models/UserRoleAssignment.js';
import { hasEffectivePermission } from '../../services/authorization/permission.service.js';
import { getRequestVisibilityFilter, resolveRequestVisibility } from '../requests/request.service.js';
import { getApprovalAnalytics } from './analytics/approval.analytics.js';

const objectId = (id) => new mongoose.Types.ObjectId(String(id));
const BUILT_IN_ROLE_TYPES = ['ORGANIZATION_ADMIN', 'DEPARTMENT_MANAGER', 'EMPLOYEE', 'FINANCE_APPROVER'];

const countCard = (key, title, value) => ({
  key,
  title,
  value: Number(value || 0),
  format: 'NUMBER',
  trend: null,
});

const amountCard = (key, title, value) => ({
  key,
  title,
  value: Number(value || 0),
  format: 'AMOUNT',
  unit: 'REQUEST_AMOUNT_UNSPECIFIED',
  trend: null,
});

const requestStats = async ({ organizationId, dateRange, visibilityFilter }) => {
  const match = {
    organizationId: objectId(organizationId),
    createdAt: { $gte: dateRange.fromDate, $lt: dateRange.toDate },
    ...visibilityFilter,
  };
  const [stats = {}] = await Request.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        draft: { $sum: { $cond: [{ $eq: ['$status', 'DRAFT'] }, 1, 0] } },
        pending: {
          $sum: {
            $cond: [{ $in: ['$status', ['SUBMITTED', 'PENDING_APPROVAL']] }, 1, 0],
          },
        },
        approved: { $sum: { $cond: [{ $eq: ['$status', 'APPROVED'] }, 1, 0] } },
        rejected: { $sum: { $cond: [{ $eq: ['$status', 'REJECTED'] }, 1, 0] } },
        returned: { $sum: { $cond: [{ $eq: ['$status', 'RETURNED'] }, 1, 0] } },
      },
    },
  ]);
  return stats;
};

const requestKpis = async ({ organizationId, dateRange, requestVisibility, actorId }) => {
  const stats = await requestStats({
    organizationId,
    dateRange,
    visibilityFilter: getRequestVisibilityFilter({ actorId, requestVisibility }),
  });
  if (requestVisibility.canViewOrganization) {
    return [
      countCard('TOTAL_REQUESTS', 'Total Requests', stats.total),
      countCard('PENDING_REQUESTS', 'Pending Requests', stats.pending),
      countCard('APPROVED_REQUESTS', 'Approved Requests', stats.approved),
      countCard('REJECTED_REQUESTS', 'Rejected Requests', stats.rejected),
      countCard('RETURNED_REQUESTS', 'Returned Requests', stats.returned),
    ];
  }
  if (requestVisibility.isCustomRequestViewer) {
    return [
      countCard('ACCESSIBLE_REQUESTS', 'Accessible Requests', stats.total),
      countCard('ACCESSIBLE_PENDING_REQUESTS', 'Accessible Pending Requests', stats.pending),
      countCard('ACCESSIBLE_APPROVED_REQUESTS', 'Accessible Approved Requests', stats.approved),
      countCard('ACCESSIBLE_REJECTED_REQUESTS', 'Accessible Rejected Requests', stats.rejected),
      countCard('ACCESSIBLE_RETURNED_REQUESTS', 'Accessible Returned Requests', stats.returned),
    ];
  }
  return [
    countCard('MY_TOTAL_REQUESTS', 'My Total Requests', stats.total),
    countCard('MY_DRAFT_REQUESTS', 'My Draft Requests', stats.draft),
    countCard('MY_PENDING_REQUESTS', 'My Pending Requests', stats.pending),
    countCard('MY_APPROVED_REQUESTS', 'My Approved Requests', stats.approved),
    countCard('MY_REJECTED_REQUESTS', 'My Rejected Requests', stats.rejected),
    countCard('MY_RETURNED_REQUESTS', 'My Returned Requests', stats.returned),
  ];
};

const delegationRecords = async ({ organizationId, userId, now }) => {
  const delegators = await User.find({
    accountStatus: 'ACTIVE',
    organizationMemberships: { $elemMatch: { organizationId, status: 'ACTIVE' } },
    approvalDelegations: {
      $elemMatch: {
        organizationId,
        delegateId: userId,
        status: 'ACTIVE',
        startsAt: { $lte: now },
        endsAt: { $gt: now },
      },
    },
  }).select('_id approvalDelegations').lean();
  return new Map(delegators.map((user) => [
    String(user._id),
    user.approvalDelegations.filter((delegation) =>
      String(delegation.organizationId) === String(organizationId) &&
      String(delegation.delegateId) === String(userId) &&
      delegation.status === 'ACTIVE' &&
      delegation.startsAt <= now &&
      delegation.endsAt > now
    ),
  ]));
};

const hasActiveDelegation = (delegations, delegatorId, departmentId, stageId, now) =>
  (delegations.get(String(delegatorId)) || []).some((delegation) =>
    (delegation.scopeType === 'ORGANIZATION' ||
      String(delegation.departmentId) === String(departmentId)) &&
    (!delegation.stageIds.length || delegation.stageIds.includes(stageId)) &&
    delegation.startsAt <= now &&
    delegation.endsAt > now
  );

const assignedApprovals = async ({ organizationId, userId, access, now, delegations }) => {
  const delegatorIds = [...delegations.keys()];
  const approverIds = [objectId(userId), ...delegatorIds.map(objectId)];
  const candidates = await ApprovalStep.aggregate([
    {
      $match: {
        organizationId: objectId(organizationId),
        approverId: { $in: approverIds },
        status: { $in: ['ACTIVE', 'CLAIMED'] },
        $or: [
          { status: 'ACTIVE' },
          { status: 'CLAIMED', claimedBy: objectId(userId) },
        ],
      },
    },
    {
      $lookup: {
        from: 'requests',
        let: { requestId: '$requestId', organizationId: '$organizationId' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$_id', '$$requestId'] },
                  { $eq: ['$organizationId', '$$organizationId'] },
                  { $eq: ['$status', 'PENDING_APPROVAL'] },
                ],
              },
            },
          },
          { $project: { departmentId: 1, currentSequence: 1 } },
        ],
        as: 'request',
      },
    },
    { $unwind: '$request' },
    { $match: { $expr: { $eq: ['$sequence', '$request.currentSequence'] } } },
    {
      $project: {
        requestId: 1,
        attemptNumber: 1,
        sequence: 1,
        stageId: 1,
        status: 1,
        approverId: 1,
        claimedBy: 1,
        assignmentResolution: 1,
        isOverdue: 1,
        claimExpiresAt: 1,
        request: 1,
      },
    },
  ]);
  if (!candidates.length) return { pending: 0, available: 0, overdue: 0 };

  const requestIds = [...new Set(candidates.map((step) => step.requestId))];
  const attempts = await ApprovalStep.aggregate([
    { $match: { organizationId: objectId(organizationId), requestId: { $in: requestIds } } },
    { $group: { _id: '$requestId', attemptNumber: { $max: '$attemptNumber' } } },
  ]);
  const currentAttempt = new Map(attempts.map((item) => [String(item._id), item.attemptNumber]));
  const currentCandidates = candidates.filter((step) =>
    Number(step.attemptNumber) === Number(currentAttempt.get(String(step.requestId))) &&
    !(step.status === 'CLAIMED' && step.claimExpiresAt && step.claimExpiresAt <= now) &&
    hasEffectivePermission(access, 'requests.approve', step.request.departmentId) &&
    (String(step.approverId) === String(userId) ||
      hasActiveDelegation(delegations, step.approverId, step.request.departmentId, step.stageId, now))
  );
  const stageKeys = [...new Set(currentCandidates.map((step) =>
    `${step.requestId}:${step.attemptNumber}:${step.sequence}`
  ))];
  const claimedStages = new Set();
  if (stageKeys.length) {
    const claimed = await ApprovalStep.aggregate([
      {
        $match: {
          organizationId: objectId(organizationId),
          requestId: { $in: [...new Set(currentCandidates.map((step) => step.requestId))] },
          status: 'CLAIMED',
        },
      },
      { $project: { requestId: 1, attemptNumber: 1, sequence: 1, claimedBy: 1 } },
      {
        $group: {
          _id: { requestId: '$requestId', attemptNumber: '$attemptNumber', sequence: '$sequence' },
          claimedBy: { $addToSet: '$claimedBy' },
        },
      },
    ]);
    claimed.forEach(({ _id, claimedBy }) => {
      const key = `${_id.requestId}:${_id.attemptNumber}:${_id.sequence}`;
      if (Number(_id.attemptNumber) === Number(currentAttempt.get(String(_id.requestId))) &&
          claimedBy.some((claimer) => claimer && String(claimer) !== String(userId))) {
        claimedStages.add(key);
      }
    });
  }

  const actionable = new Map();
  const unclaimedClaimOne = new Set();
  const overdue = new Set();
  for (const step of currentCandidates) {
    const key = `${step.requestId}:${step.attemptNumber}:${step.sequence}`;
    if (claimedStages.has(key)) continue;
    actionable.set(key, true);
    if (step.isOverdue) overdue.add(key);
    if (step.assignmentResolution === 'CLAIM_ONE' &&
        step.status === 'ACTIVE' &&
        !step.claimedBy &&
        !claimedStages.has(key)) {
      unclaimedClaimOne.add(key);
    }
  }
  return {
    pending: actionable.size,
    available: unclaimedClaimOne.size,
    overdue: overdue.size,
  };
};

const approvalActions = async ({
  organizationId,
  userId,
  access,
  dateRange,
  now,
  delegations,
  financeRoleIds,
}) => {
  const steps = await ApprovalStep.aggregate([
    {
      $match: {
        organizationId: objectId(organizationId),
        decidedBy: objectId(userId),
        status: { $in: ['APPROVED', 'REJECTED', 'RETURNED'] },
        decisionAt: { $gte: dateRange.fromDate, $lt: dateRange.toDate },
      },
    },
    {
      $lookup: {
        from: 'requests',
        let: { requestId: '$requestId', organizationId: '$organizationId' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$_id', '$$requestId'] },
                  { $eq: ['$organizationId', '$$organizationId'] },
                ],
              },
            },
          },
          { $project: { departmentId: 1, amount: 1 } },
        ],
        as: 'request',
      },
    },
    { $unwind: '$request' },
    {
      $project: {
        status: 1,
        stageId: 1,
        approverId: 1,
        roleId: 1,
        actedOnBehalfOf: 1,
        requestId: 1,
        request: 1,
      },
    },
  ]);
  const validActions = steps.filter((step) =>
    hasEffectivePermission(access, 'requests.approve', step.request.departmentId) &&
    (!step.actedOnBehalfOf ||
      hasActiveDelegation(delegations, step.approverId, step.request.departmentId, step.stageId, now))
  );
  const approvedRequests = new Map();
  const counts = { APPROVED: 0, REJECTED: 0, RETURNED: 0 };
  for (const step of validActions) {
    counts[step.status] += 1;
    if (step.status === 'APPROVED' && financeRoleIds.has(String(step.roleId))) {
      approvedRequests.set(String(step.requestId), Number(step.request.amount) || 0);
    }
  }
  return {
    counts,
    approvedAmount: [...approvedRequests.values()].reduce((sum, amount) => sum + amount, 0),
  };
};

const organizationWideApprovalKpis = async ({ organizationId, userId, access, dateRange }) => {
  const analytics = await getApprovalAnalytics({ userId, organizationId, access, dateRange });
  const decisionCounts = Object.fromEntries(
    (analytics.decisions || []).map((item) => [item.decision, item.count])
  );
  const kpis = [
    countCard('PENDING_APPROVAL', 'Pending Approval', analytics.workload.pendingApprovalStages),
    countCard('AVAILABLE_TO_CLAIM', 'Available to Claim', analytics.workload.availableToClaimStages),
    countCard('APPROVED_DECISIONS', 'Approved Decisions', decisionCounts.APPROVED || 0),
    countCard('REJECTED_DECISIONS', 'Rejected Decisions', decisionCounts.REJECTED || 0),
    countCard('RETURNED_DECISIONS', 'Returned Decisions', decisionCounts.RETURNED || 0),
    countCard('OVERDUE_APPROVALS', 'Overdue Approvals', analytics.workload.currentlyOverdueStages),
  ];
  return kpis;
};

const approvalKpis = async ({ organizationId, userId, access, dateRange }) => {
  const now = new Date();
  const delegations = await delegationRecords({ organizationId, userId, now });
  const financeRoleIds = new Set(access.assignments
    .filter((assignment) =>
      assignment.roleId?.roleType === 'FINANCE_APPROVER' ||
      assignment.roleId?.rolePurpose === 'FINANCE_APPROVER'
    )
    .map((assignment) => String(assignment.roleId._id)));
  const [workload, actions] = await Promise.all([
    assignedApprovals({ organizationId, userId, access, now, delegations }),
    approvalActions({ organizationId, userId, access, dateRange, now, delegations, financeRoleIds }),
  ]);
  const kpis = [
    countCard('PENDING_MY_APPROVAL', 'Pending My Approval', workload.pending),
    countCard('AVAILABLE_TO_CLAIM', 'Available to Claim', workload.available),
    countCard('APPROVED_BY_ME', 'Approved by Me', actions.counts.APPROVED),
    countCard('REJECTED_BY_ME', 'Rejected by Me', actions.counts.REJECTED),
    countCard('RETURNED_BY_ME', 'Returned by Me', actions.counts.RETURNED),
    countCard('OVERDUE_APPROVALS', 'Overdue Approvals', workload.overdue),
  ];
  if (financeRoleIds.size) {
    kpis.push(amountCard('TOTAL_APPROVED_AMOUNT', 'Total Approved Amount', actions.approvedAmount));
  }
  return kpis;
};

const organizationKpis = async ({ organizationId, access }) => {
  const kpis = [];
  const userScopes = access.scopedPermissions.get('users.view');
  const departmentScopes = access.scopedPermissions.get('departments.view');
  const userCount = access.organizationPermissions.has('users.view') || userScopes?.size
    ? User.countDocuments({
      accountStatus: 'ACTIVE',
      organizationMemberships: {
        $elemMatch: {
          organizationId: objectId(organizationId),
          status: 'ACTIVE',
          ...(!access.organizationPermissions.has('users.view')
            ? { departmentId: { $in: [...userScopes].map(objectId) } }
            : {}),
        },
      },
    })
    : null;
  const departmentCount = access.organizationPermissions.has('departments.view')
    ? Department.countDocuments({ organizationId, status: 'ACTIVE' })
    : departmentScopes?.size
      ? Department.countDocuments({
        organizationId,
        status: 'ACTIVE',
        _id: { $in: [...departmentScopes].map(objectId) },
      })
      : null;
  const [users, departments] = await Promise.all([
    userCount || Promise.resolve(null),
    departmentCount || Promise.resolve(null),
  ]);
  if (users !== null) kpis.push(countCard('TOTAL_EMPLOYEES', 'Total Employees', users));
  if (departments !== null) kpis.push(countCard('TOTAL_DEPARTMENTS', 'Total Departments', departments));
  return kpis;
};

const roleKpis = async ({ organizationId }) => {
  const assignmentFilter = {
    organizationId: objectId(organizationId),
    status: 'ACTIVE',
  };
  const roleFilter = {
    organizationId: objectId(organizationId),
  };
  const [roleGroups, assignmentCount] = await Promise.all([
    Role.aggregate([
      { $match: roleFilter },
      {
        $group: {
          _id: {
            $cond: [
              { $in: ['$roleType', BUILT_IN_ROLE_TYPES] },
              'BUILT_IN',
              'CUSTOM',
            ],
          },
          count: { $sum: 1 },
        },
      },
    ]),
    UserRoleAssignment.countDocuments(assignmentFilter),
  ]);
  const countByType = new Map(roleGroups.map(({ _id, count }) => [_id, count]));
  const builtInRoles = countByType.get('BUILT_IN') || 0;
  const customRoles = countByType.get('CUSTOM') || 0;
  return [
    countCard('TOTAL_ROLES', 'Total Roles', builtInRoles + customRoles),
    countCard('BUILT_IN_ROLES', 'Built-in Roles', builtInRoles),
    countCard('CUSTOM_ROLES', 'Custom Roles', customRoles),
    countCard('ACTIVE_ROLE_ASSIGNMENTS', 'Active Role Assignments', assignmentCount),
  ];
};

const platformKpis = async ({ dateRange }) => {
  const [
    organizationsResult,
    newOrganizations,
    totalUsers,
    activeUsers,
    inactiveUsers,
    membershipResult,
    totalDepartments,
    totalRequests,
    pendingRequests,
    approvedRequests,
    rejectedRequests,
    returnedRequests,
    cancelledRequests,
  ] = await Promise.all([
    Organization.aggregate([
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          active: { $sum: { $cond: [{ $eq: ['$status', 'ACTIVE'] }, 1, 0] } },
          inactive: { $sum: { $cond: [{ $eq: ['$status', 'INACTIVE'] }, 1, 0] } },
        },
      },
    ]),
    Organization.countDocuments({
      createdAt: { $gte: dateRange.fromDate, $lt: dateRange.toDate },
    }),
    User.countDocuments({}),
    User.countDocuments({ accountStatus: 'ACTIVE' }),
    User.countDocuments({ accountStatus: 'INACTIVE' }),
    User.aggregate([
      { $unwind: '$organizationMemberships' },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          active: { $sum: { $cond: [{ $eq: ['$organizationMemberships.status', 'ACTIVE'] }, 1, 0] } },
          inactive: { $sum: { $cond: [{ $eq: ['$organizationMemberships.status', 'INACTIVE'] }, 1, 0] } },
        },
      },
    ]),
    Department.countDocuments({}),
    Request.countDocuments({}),
    Request.countDocuments({ status: { $in: ['SUBMITTED', 'PENDING_APPROVAL'] } }),
    Request.countDocuments({ status: 'APPROVED' }),
    Request.countDocuments({ status: 'REJECTED' }),
    Request.countDocuments({ status: 'RETURNED' }),
    Request.countDocuments({ status: 'CANCELLED' }),
  ]);
  const [organizations = {}] = organizationsResult;
  const [memberships = {}] = membershipResult;
  return [
    countCard('TOTAL_ORGANIZATIONS', 'Total Organizations', organizations.total),
    countCard('ACTIVE_ORGANIZATIONS', 'Active Organizations', organizations.active),
    countCard('INACTIVE_ORGANIZATIONS', 'Inactive Organizations', organizations.inactive),
    countCard('NEW_ORGANIZATIONS', 'New Organizations', newOrganizations),
    countCard('TOTAL_USERS', 'Total Users', totalUsers),
    countCard('ACTIVE_USERS', 'Active Users', activeUsers),
    countCard('INACTIVE_USERS', 'Inactive Users', inactiveUsers),
    countCard('TOTAL_ORGANIZATION_MEMBERSHIPS', 'Total Organization Memberships', memberships.total),
    countCard('ACTIVE_ORGANIZATION_MEMBERSHIPS', 'Active Organization Memberships', memberships.active),
    countCard('INACTIVE_ORGANIZATION_MEMBERSHIPS', 'Inactive Organization Memberships', memberships.inactive),
    countCard('TOTAL_DEPARTMENTS', 'Total Departments', totalDepartments),
    countCard('TOTAL_REQUESTS', 'Total Requests', totalRequests),
    countCard('PENDING_REQUESTS', 'Pending Requests', pendingRequests),
    countCard('APPROVED_REQUESTS', 'Approved Requests', approvedRequests),
    countCard('REJECTED_REQUESTS', 'Rejected Requests', rejectedRequests),
    countCard('RETURNED_REQUESTS', 'Returned Requests', returnedRequests),
    countCard('CANCELLED_REQUESTS', 'Cancelled Requests', cancelledRequests),
  ];
};

export const getDashboardKpis = async ({
  dashboardType,
  userId,
  organizationId,
  access,
  dateRange,
  implementedProviders,
}) => {
  if (dashboardType === 'PLATFORM') {
    return implementedProviders.has('PLATFORM') ? platformKpis({ dateRange }) : [];
  }

  const canViewRequests = access.organizationPermissions.has('requests.view') ||
    (access.scopedPermissions.get('requests.view')?.size || 0) > 0;
  const canApproveRequests = access.organizationPermissions.has('requests.approve') ||
    (access.scopedPermissions.get('requests.approve')?.size || 0) > 0;
  const organizationAdmin = access.assignments.some(
    (assignment) => assignment.roleId?.roleType === 'ORGANIZATION_ADMIN'
  );
  const canViewRoleOverview = access.organizationPermissions.has('roles.view') &&
    access.assignments.some((assignment) =>
      assignment.scopeType === 'ORGANIZATION' &&
      !assignment.departmentId &&
      assignment.roleId?.roleType === 'ORGANIZATION_ADMIN'
    );
  const organizationWideApprovals = organizationAdmin && access.organizationPermissions.has('requests.approve');
  const requestVisibility = implementedProviders.has('REQUESTS') && canViewRequests
    ? await resolveRequestVisibility({ organizationId, actorId: userId, access })
    : null;
  const [requestCards, approvalCards, organizationCards, roleCards] = await Promise.all([
    implementedProviders.has('REQUESTS') && canViewRequests
      ? requestKpis({ organizationId, dateRange, requestVisibility, actorId: userId })
      : [],
    implementedProviders.has('APPROVALS') && canApproveRequests
      ? organizationWideApprovals
        ? organizationWideApprovalKpis({ organizationId, userId, access, dateRange })
        : approvalKpis({ organizationId, userId, access, dateRange })
      : [],
    implementedProviders.has('ORGANIZATION')
      ? organizationKpis({ organizationId, access })
      : [],
    implementedProviders.has('ROLES') && canViewRoleOverview
      ? roleKpis({ organizationId })
      : [],
  ]);
  return [...requestCards, ...approvalCards, ...organizationCards, ...roleCards];
};

export default { getDashboardKpis };
