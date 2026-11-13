import AuditLog from '../../../models/AuditLog.js';
import Department from '../../../models/Department.js';
import Organization from '../../../models/Organization.js';
import Request from '../../../models/Request.js';
import User from '../../../models/User.js';
import UserRoleAssignment from '../../../models/UserRoleAssignment.js';
import { AUDIT_ACTIONS, ENTITY_STATUS, REQUEST_STATUSES } from '../../../config/constants.js';
import { USER_ACTIONS } from '../../users/user.constants.js';
import { ROLE_ACTIONS } from '../../roles/role.constants.js';
import { DEPARTMENT_ACTIONS } from '../../departments/department.constants.js';
import { buildPeriods, groupingForRange, percentageChange } from './analytics.utils.js';

const dateMatch = (field, dateRange) => ({
  [field]: { $gte: dateRange.fromDate, $lt: dateRange.toDate },
});

const dateGroup = (field, unit) => ({
  $dateTrunc: {
    date: `$${field}`,
    unit,
    timezone: 'UTC',
    ...(unit === 'week' ? { startOfWeek: 'monday' } : {}),
  },
});

const completeSeries = (dateRange, unit, rows) => {
  const counts = new Map(rows.map((row) => [new Date(row._id).toISOString(), row.count]));
  return buildPeriods(dateRange, unit).map((period) => ({
    period: period.period,
    periodStart: period.periodStart.toISOString(),
    count: counts.get(period.periodStart.toISOString()) || 0,
  }));
};

const periodComparison = async ({ model, dateRange }) => {
  const duration = dateRange.toDate.getTime() - dateRange.fromDate.getTime();
  const previousFrom = new Date(dateRange.fromDate.getTime() - duration);
  const [currentPeriodCount, previousPeriodCount] = await Promise.all([
    model.countDocuments(dateMatch('createdAt', dateRange)),
    model.countDocuments({
      createdAt: { $gte: previousFrom, $lt: dateRange.fromDate },
    }),
  ]);
  return {
    currentPeriodCount,
    previousPeriodCount,
    ...percentageChange(currentPeriodCount, previousPeriodCount),
  };
};

const statusDistribution = (rows, statuses) => statuses.map((status) => ({
  status,
  count: rows.find((row) => row._id === status)?.count || 0,
}));

export const getPlatformOrganizationAnalytics = async (dateRange) => {
  const unit = groupingForRange(dateRange);
  const [trendRows, statusRows, organizations, membershipRows, departmentRows, lifetimeRequestRows, periodRequestRows] =
    await Promise.all([
      Organization.aggregate([
        { $match: dateMatch('createdAt', dateRange) },
        { $group: { _id: dateGroup('createdAt', unit), count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
      Organization.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
      Organization.find({}).select('_id name status createdAt').sort({ name: 1, _id: 1 }).lean(),
      User.aggregate([
        { $unwind: '$organizationMemberships' },
        { $match: { 'organizationMemberships.organizationId': { $exists: true } } },
        {
          $group: {
            _id: '$organizationMemberships.organizationId',
            totalMemberships: { $sum: 1 },
            activeMemberships: {
              $sum: { $cond: [{ $eq: ['$organizationMemberships.status', 'ACTIVE'] }, 1, 0] },
            },
            inactiveMemberships: {
              $sum: { $cond: [{ $eq: ['$organizationMemberships.status', 'INACTIVE'] }, 1, 0] },
            },
          },
        },
      ]),
      Department.aggregate([
        { $group: { _id: '$organizationId', totalDepartments: { $sum: 1 } } },
      ]),
      Request.aggregate([
        { $group: { _id: '$organizationId', totalRequests: { $sum: 1 } } },
      ]),
      Request.aggregate([
        { $match: dateMatch('createdAt', dateRange) },
        { $group: { _id: '$organizationId', periodRequests: { $sum: 1 } } },
      ]),
    ]);

  const membershipByOrganization = new Map(membershipRows.map((row) => [String(row._id), row]));
  const departmentByOrganization = new Map(departmentRows.map((row) => [String(row._id), row.totalDepartments]));
  const lifetimeRequestByOrganization = new Map(lifetimeRequestRows.map((row) => [String(row._id), row.totalRequests]));
  const periodRequestByOrganization = new Map(periodRequestRows.map((row) => [String(row._id), row.periodRequests]));
  const registrationComparison = await periodComparison({ model: Organization, dateRange });

  return {
    scope: 'PLATFORM',
    grouping: unit.toUpperCase(),
    registrationTrends: completeSeries(dateRange, unit, trendRows),
    statusDistribution: statusDistribution(statusRows, ENTITY_STATUS),
    organizationComparison: registrationComparison,
    organizations: organizations.map((organization) => {
      const membership = membershipByOrganization.get(String(organization._id)) || {};
      return {
        organizationId: String(organization._id),
        organizationName: organization.name,
        status: organization.status,
        createdAt: organization.createdAt,
        totalMemberships: membership.totalMemberships || 0,
        activeMemberships: membership.activeMemberships || 0,
        inactiveMemberships: membership.inactiveMemberships || 0,
        totalDepartments: departmentByOrganization.get(String(organization._id)) || 0,
        totalRequests: lifetimeRequestByOrganization.get(String(organization._id)) || 0,
        periodRequests: periodRequestByOrganization.get(String(organization._id)) || 0,
      };
    }),
  };
};

export const getPlatformUserAnalytics = async (dateRange) => {
  const unit = groupingForRange(dateRange);
  const [
    totalUniqueUsers,
    activeUniqueUsers,
    inactiveUniqueUsers,
    membershipRows,
    trendRows,
    roleRows,
  ] = await Promise.all([
    User.countDocuments({}),
    User.countDocuments({ accountStatus: 'ACTIVE' }),
    User.countDocuments({ accountStatus: 'INACTIVE' }),
    User.aggregate([
      { $unwind: '$organizationMemberships' },
      {
        $group: {
          _id: '$organizationMemberships.organizationId',
          totalMemberships: { $sum: 1 },
          activeMemberships: {
            $sum: { $cond: [{ $eq: ['$organizationMemberships.status', 'ACTIVE'] }, 1, 0] },
          },
          inactiveMemberships: {
            $sum: { $cond: [{ $eq: ['$organizationMemberships.status', 'INACTIVE'] }, 1, 0] },
          },
        },
      },
      {
        $lookup: {
          from: 'organizations',
          localField: '_id',
          foreignField: '_id',
          pipeline: [{ $project: { name: 1 } }],
          as: 'organization',
        },
      },
      { $unwind: { path: '$organization', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          organizationId: { $toString: '$_id' },
          organizationName: { $ifNull: ['$organization.name', null] },
          totalMemberships: 1,
          activeMemberships: 1,
          inactiveMemberships: 1,
        },
      },
      { $sort: { organizationName: 1, organizationId: 1 } },
    ]),
    User.aggregate([
      { $match: dateMatch('createdAt', dateRange) },
      { $group: { _id: dateGroup('createdAt', unit), count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    UserRoleAssignment.aggregate([
      { $match: { status: 'ACTIVE' } },
      {
        $lookup: {
          from: 'roles',
          localField: 'roleId',
          foreignField: '_id',
          as: 'role',
        },
      },
      { $unwind: '$role' },
      { $match: { 'role.status': 'ACTIVE' } },
      {
        $lookup: {
          from: 'users',
          localField: 'userId',
          foreignField: '_id',
          pipeline: [{ $project: { accountStatus: 1 } }],
          as: 'user',
        },
      },
      { $unwind: '$user' },
      { $match: { 'user.accountStatus': 'ACTIVE' } },
      {
        $project: {
          userId: 1,
          roleCategory: {
            $switch: {
              branches: [
                { case: { $eq: ['$role.roleType', 'ORGANIZATION_ADMIN'] }, then: 'ORGANIZATION_ADMIN' },
                { case: { $eq: ['$role.roleType', 'DEPARTMENT_MANAGER'] }, then: 'DEPARTMENT_MANAGER' },
                { case: { $eq: ['$role.roleType', 'EMPLOYEE'] }, then: 'DEPARTMENT_MEMBER' },
                { case: { $eq: ['$role.roleType', 'FINANCE_APPROVER'] }, then: 'FINANCE_APPROVER' },
                { case: { $eq: ['$role.rolePurpose', 'FINANCE_APPROVER'] }, then: 'FINANCE_APPROVER' },
              ],
              default: 'CUSTOM',
            },
          },
        },
      },
      { $group: { _id: { userId: '$userId', roleCategory: '$roleCategory' } } },
      { $group: { _id: '$_id.roleCategory', uniqueUsers: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
  ]);

  return {
    scope: 'PLATFORM',
    userCounts: {
      totalUniqueUsers,
      activeUniqueUsers,
      inactiveUniqueUsers,
      activeUserBasis: 'USER_ACCOUNT_STATUS',
    },
    membershipCounts: {
      total: membershipRows.reduce((sum, row) => sum + row.totalMemberships, 0),
      active: membershipRows.reduce((sum, row) => sum + row.activeMemberships, 0),
      inactive: membershipRows.reduce((sum, row) => sum + row.inactiveMemberships, 0),
      basis: 'ORGANIZATION_MEMBERSHIPS',
    },
    byOrganization: membershipRows,
    byRoleCategory: roleRows.map((row) => ({
      roleCategory: row._id,
      uniqueUsers: row.uniqueUsers,
      metricBasis: 'UNIQUE_ACTIVE_USERS_WITH_ACTIVE_ASSIGNMENT',
    })),
    registrationTrends: completeSeries(dateRange, unit, trendRows),
    grouping: unit.toUpperCase(),
  };
};

export const getPlatformRequestAnalytics = async (dateRange) => {
  const unit = groupingForRange(dateRange);
  const requestDateFilter = dateMatch('createdAt', dateRange);
  const duration = dateRange.toDate.getTime() - dateRange.fromDate.getTime();
  const previousFrom = new Date(dateRange.fromDate.getTime() - duration);
  const [
    trendRows,
    statusRows,
    typeRows,
    organizationRows,
    currentPeriodCount,
    previousPeriodCount,
  ] = await Promise.all([
    Request.aggregate([
      { $match: requestDateFilter },
      { $group: { _id: dateGroup('createdAt', unit), count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    Request.aggregate([
      { $match: requestDateFilter },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    Request.aggregate([
      { $match: requestDateFilter },
      {
        $group: {
          _id: { $ifNull: ['$requestTypeName', '$requestType'] },
          total: { $sum: 1 },
        },
      },
      { $sort: { total: -1, _id: 1 } },
    ]),
    Request.aggregate([
      { $match: requestDateFilter },
      {
        $group: {
          _id: '$organizationId',
          totalRequests: { $sum: 1 },
          pendingRequests: {
            $sum: { $cond: [{ $in: ['$status', ['SUBMITTED', 'PENDING_APPROVAL']] }, 1, 0] },
          },
          approvedRequests: {
            $sum: { $cond: [{ $eq: ['$status', 'APPROVED'] }, 1, 0] },
          },
          rejectedRequests: {
            $sum: { $cond: [{ $eq: ['$status', 'REJECTED'] }, 1, 0] },
          },
          returnedRequests: {
            $sum: { $cond: [{ $eq: ['$status', 'RETURNED'] }, 1, 0] },
          },
        },
      },
      {
        $lookup: {
          from: 'organizations',
          localField: '_id',
          foreignField: '_id',
          pipeline: [{ $project: { name: 1 } }],
          as: 'organization',
        },
      },
      { $unwind: { path: '$organization', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          organizationId: { $toString: '$_id' },
          organizationName: { $ifNull: ['$organization.name', null] },
          totalRequests: 1,
          pendingRequests: 1,
          approvedRequests: 1,
          rejectedRequests: 1,
          returnedRequests: 1,
        },
      },
      { $sort: { totalRequests: -1, organizationName: 1 } },
    ]),
    Request.countDocuments(requestDateFilter),
    Request.countDocuments({ createdAt: { $gte: previousFrom, $lt: dateRange.fromDate } }),
  ]);

  return {
    scope: 'PLATFORM',
    grouping: unit.toUpperCase(),
    requestTrends: completeSeries(dateRange, unit, trendRows),
    statusDistribution: statusDistribution(statusRows, REQUEST_STATUSES),
    requestTypes: typeRows.map((row) => ({ requestType: row._id || 'Unknown', total: row.total })),
    requestsByOrganization: organizationRows,
    requestVolumeComparison: {
      currentPeriodCount,
      previousPeriodCount,
      ...percentageChange(currentPeriodCount, previousPeriodCount),
    },
  };
};

export const getPlatformDepartmentAnalytics = async (dateRange) => {
  const unit = groupingForRange(dateRange);
  const [totalDepartments, statusRows, organizationRows, trendRows] = await Promise.all([
    Department.countDocuments({}),
    Department.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    Department.aggregate([
      {
        $group: {
          _id: '$organizationId',
          totalDepartments: { $sum: 1 },
          activeDepartments: {
            $sum: { $cond: [{ $eq: ['$status', 'ACTIVE'] }, 1, 0] },
          },
          inactiveDepartments: {
            $sum: { $cond: [{ $eq: ['$status', 'INACTIVE'] }, 1, 0] },
          },
        },
      },
      {
        $lookup: {
          from: 'organizations',
          localField: '_id',
          foreignField: '_id',
          pipeline: [{ $project: { name: 1 } }],
          as: 'organization',
        },
      },
      { $unwind: { path: '$organization', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          organizationId: { $toString: '$_id' },
          organizationName: { $ifNull: ['$organization.name', null] },
          totalDepartments: 1,
          activeDepartments: 1,
          inactiveDepartments: 1,
        },
      },
      { $sort: { organizationName: 1, organizationId: 1 } },
    ]),
    Department.aggregate([
      { $match: dateMatch('createdAt', dateRange) },
      { $group: { _id: dateGroup('createdAt', unit), count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
  ]);

  return {
    scope: 'PLATFORM',
    totalDepartments,
    statusDistribution: statusDistribution(statusRows, ENTITY_STATUS),
    byOrganization: organizationRows,
    departmentGrowth: completeSeries(dateRange, unit, trendRows),
    grouping: unit.toUpperCase(),
  };
};

const platformAdministrativeEvents = [
  { resourceType: 'Organization', action: { $in: Object.values(AUDIT_ACTIONS) } },
  {
    resourceType: 'User',
    action: {
      $in: [
        USER_ACTIONS.CREATED,
        USER_ACTIONS.UPDATED,
        USER_ACTIONS.ACTIVATED,
        USER_ACTIONS.DEACTIVATED,
        USER_ACTIONS.DEPARTMENT_ASSIGNED,
        USER_ACTIONS.DEPARTMENT_REMOVED,
        USER_ACTIONS.ROLE_ASSIGNED,
      ],
    },
  },
  {
    resourceType: 'Role',
    action: {
      $in: [
        ROLE_ACTIONS.CREATED,
        ROLE_ACTIONS.UPDATED,
        ROLE_ACTIONS.PERMISSIONS_UPDATED,
        ROLE_ACTIONS.ACTIVATED,
        ROLE_ACTIONS.DEACTIVATED,
        ROLE_ACTIONS.ASSIGNED,
        ROLE_ACTIONS.UNASSIGNED,
      ],
    },
  },
  {
    resourceType: 'Department',
    action: {
      $in: [
        DEPARTMENT_ACTIONS.CREATED,
        DEPARTMENT_ACTIONS.UPDATED,
        DEPARTMENT_ACTIONS.MANAGER_ASSIGNED,
        DEPARTMENT_ACTIONS.MANAGER_REMOVED,
        DEPARTMENT_ACTIONS.MEMBER_ADDED,
        DEPARTMENT_ACTIONS.MEMBER_REMOVED,
        DEPARTMENT_ACTIONS.ACTIVATED,
        DEPARTMENT_ACTIONS.DEACTIVATED,
      ],
    },
  },
];

export const getPlatformRecentActivity = async ({ dateRange, page, limit }) => {
  const filter = {
    timestamp: dateMatch('timestamp', dateRange).timestamp,
    $or: platformAdministrativeEvents,
  };
  const [result = { items: [], metadata: [] }] = await AuditLog.aggregate([
    { $match: filter },
    { $sort: { timestamp: -1, _id: -1 } },
    {
      $facet: {
        items: [
          { $skip: (page - 1) * limit },
          { $limit: limit },
          {
            $lookup: {
              from: 'users',
              localField: 'actorId',
              foreignField: '_id',
              pipeline: [{ $project: { name: 1 } }],
              as: 'actor',
            },
          },
          { $unwind: { path: '$actor', preserveNullAndEmptyArrays: true } },
          {
            $lookup: {
              from: 'organizations',
              localField: 'organizationId',
              foreignField: '_id',
              pipeline: [{ $project: { name: 1 } }],
              as: 'organization',
            },
          },
          { $unwind: { path: '$organization', preserveNullAndEmptyArrays: true } },
          {
            $project: {
              _id: 0,
              activityId: { $toString: '$_id' },
              action: 1,
              actor: {
                id: { $toString: '$actorId' },
                name: { $ifNull: ['$actor.name', null] },
              },
              organization: {
                id: { $toString: '$organizationId' },
                name: { $ifNull: ['$organization.name', null] },
              },
              target: {
                type: '$resourceType',
                id: { $toString: '$resourceId' },
              },
              timestamp: 1,
            },
          },
        ],
        metadata: [{ $count: 'total' }],
      },
    },
  ]);
  const total = result.metadata[0]?.total || 0;
  const totalPages = total ? Math.ceil(total / limit) : 0;
  return {
    scope: 'PLATFORM',
    items: result.items,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1 && total > 0,
    },
  };
};

export default {
  getPlatformOrganizationAnalytics,
  getPlatformUserAnalytics,
  getPlatformRequestAnalytics,
  getPlatformDepartmentAnalytics,
  getPlatformRecentActivity,
};
