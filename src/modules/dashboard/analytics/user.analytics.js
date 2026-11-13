import mongoose from 'mongoose';
import Department from '../../../models/Department.js';
import User from '../../../models/User.js';
import { AppError } from '../../../utils/AppError.js';
import { buildPeriods, groupingForRange } from './analytics.utils.js';

const oid = (value) => new mongoose.Types.ObjectId(String(value));

const completeSeries = (dateRange, unit, rows) => {
  const counts = new Map(rows.map((row) => [new Date(row._id).toISOString(), row.count]));
  return buildPeriods(dateRange, unit).map((period) => ({
    period: period.period,
    periodStart: period.periodStart.toISOString(),
    count: counts.get(period.periodStart.toISOString()) || 0,
  }));
};

export const getTenantUserAnalytics = async ({ organizationId, access, dateRange }) => {
  const organizationWide = access.organizationPermissions.has('users.view');
  const departmentIds = access.scopedPermissions.get('users.view');
  if (!organizationWide && !departmentIds?.size) {
    throw new AppError('User analytics are not allowed in the current scope.', 403, 'FORBIDDEN');
  }

  const departmentObjectIds = organizationWide ? null : [...departmentIds].map(oid);
  const membershipMatch = {
    organizationMemberships: {
      $elemMatch: {
        organizationId: oid(organizationId),
        ...(!organizationWide ? { departmentId: { $in: departmentObjectIds } } : {}),
      },
    },
  };
  const unit = groupingForRange(dateRange);
  const [totalUsers, activeUsers, inactiveUsers, trendRows, departmentRows, departments] =
    await Promise.all([
      User.countDocuments(membershipMatch),
      User.countDocuments({ ...membershipMatch, accountStatus: 'ACTIVE' }),
      User.countDocuments({ ...membershipMatch, accountStatus: 'INACTIVE' }),
      User.aggregate([
        { $match: { ...membershipMatch, createdAt: { $gte: dateRange.fromDate, $lt: dateRange.toDate } } },
        {
          $group: {
            _id: {
              $dateTrunc: {
                date: '$createdAt',
                unit,
                timezone: 'UTC',
                ...(unit === 'week' ? { startOfWeek: 'monday' } : {}),
              },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      User.aggregate([
        { $match: membershipMatch },
        { $unwind: '$organizationMemberships' },
        {
          $match: {
            'organizationMemberships.organizationId': oid(organizationId),
            'organizationMemberships.departmentId': organizationWide
              ? { $ne: null }
              : { $in: departmentObjectIds },
          },
        },
        {
          $group: {
            _id: {
              departmentId: '$organizationMemberships.departmentId',
              userId: '$_id',
            },
            accountStatus: { $first: '$accountStatus' },
          },
        },
        {
          $group: {
            _id: '$_id.departmentId',
            totalUsers: { $sum: 1 },
            activeUsers: { $sum: { $cond: [{ $eq: ['$accountStatus', 'ACTIVE'] }, 1, 0] } },
            inactiveUsers: { $sum: { $cond: [{ $eq: ['$accountStatus', 'INACTIVE'] }, 1, 0] } },
          },
        },
      ]),
      Department.find({
        organizationId,
        ...(!organizationWide ? { _id: { $in: departmentObjectIds } } : {}),
      }).select('_id name').sort({ name: 1, _id: 1 }).lean(),
    ]);

  const rowsByDepartment = new Map(departmentRows.map((row) => [String(row._id), row]));
  return {
    scope: organizationWide ? 'ORGANIZATION' : 'AUTHORIZED_DEPARTMENTS',
    grouping: unit.toUpperCase(),
    userCounts: { totalUsers, activeUsers, inactiveUsers },
    registrationTrends: completeSeries(dateRange, unit, trendRows),
    byDepartment: departments.map((department) => {
      const row = rowsByDepartment.get(String(department._id)) || {};
      return {
        departmentId: String(department._id),
        departmentName: department.name,
        totalUsers: row.totalUsers || 0,
        activeUsers: row.activeUsers || 0,
        inactiveUsers: row.inactiveUsers || 0,
      };
    }),
  };
};

export default { getTenantUserAnalytics };
