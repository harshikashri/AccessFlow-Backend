import mongoose from 'mongoose';
import Request from '../../../models/Request.js';
import WorkflowDefinition from '../../../models/WorkflowDefinition.js';
import { AppError } from '../../../utils/AppError.js';
import { REQUEST_STATUSES } from '../../../config/constants.js';
import {
  getRequestVisibilityFilter,
  resolveRequestVisibility,
} from '../../requests/request.service.js';
import {
  buildPeriods,
  groupingForRange,
  percentageChange,
} from './analytics.utils.js';

const oid = (value) => new mongoose.Types.ObjectId(String(value));

const requestScope = async ({ userId, organizationId, access }) => {
  if (!access.organizationPermissions.has('requests.view') &&
      !(access.scopedPermissions.get('requests.view')?.size || 0)) {
    throw new AppError('Permission requests.view is required for request analytics.', 403, 'FORBIDDEN');
  }
  const visibility = await resolveRequestVisibility({ organizationId, actorId: userId, access });
  return {
    filter: getRequestVisibilityFilter({ actorId: userId, requestVisibility: visibility }),
    scope: visibility.canViewOrganization
      ? 'ORGANIZATION'
      : visibility.isCustomRequestViewer
        ? 'DEPARTMENT'
        : 'AUTHORIZED_REQUEST_HISTORY',
  };
};

const requestMatch = ({ organizationId, visibilityFilter, fromDate, toDate }) => ({
  organizationId: oid(organizationId),
  ...visibilityFilter,
  createdAt: { $gte: fromDate, $lt: toDate },
});

const dateTrunc = (unit) => ({
  $dateTrunc: {
    date: '$createdAt',
    unit,
    timezone: 'UTC',
    ...(unit === 'week' ? { startOfWeek: 'monday' } : {}),
  },
});

const analyticsPipeline = (match, unit) => [
  { $match: match },
  {
    $facet: {
      requestTrends: [
        { $group: { _id: dateTrunc(unit), count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ],
      statusDistribution: [
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ],
      requestTypes: [
        {
          $group: {
            _id: {
              requestTypeId: '$requestTypeId',
              fallbackName: {
                $cond: [
                  { $ifNull: ['$requestTypeId', false] },
                  null,
                  { $ifNull: ['$requestTypeName', '$requestType'] },
                ],
              },
            },
            total: { $sum: 1 },
            requestTypeName: { $first: '$requestTypeName' },
            requestType: { $first: '$requestType' },
            statusCounts: {
              $push: '$status',
            },
          },
        },
        {
          $lookup: {
            from: 'workflowDefinitions',
            let: { requestTypeId: '$_id.requestTypeId', organizationId: oid(match.organizationId) },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ['$_id', '$$requestTypeId'] },
                      { $eq: ['$organizationId', '$$organizationId'] },
                      { $eq: ['$definitionType', 'REQUEST_TYPE'] },
                    ],
                  },
                },
              },
              { $project: { name: 1, code: 1 } },
              { $limit: 1 },
            ],
            as: 'definition',
          },
        },
        { $unwind: { path: '$definition', preserveNullAndEmptyArrays: true } },
        { $sort: { requestTypeName: 1, requestType: 1 } },
        {
          $project: {
            _id: 0,
            requestTypeId: '$_id.requestTypeId',
            name: {
              $cond: [
                { $ifNull: ['$_id.requestTypeId', false] },
                { $ifNull: ['$definition.name', { $ifNull: ['$requestTypeName', '$requestType'] }] },
                '$_id.fallbackName',
              ],
            },
            total: 1,
            statusCounts: 1,
          },
        },
      ],
    },
  },
];

const countRequests = async ({ organizationId, visibilityFilter, fromDate, toDate }) => {
  const [result = { count: 0 }] = await Request.aggregate([
    { $match: requestMatch({ organizationId, visibilityFilter, fromDate, toDate }) },
    { $count: 'count' },
  ]);
  return result.count || 0;
};

export const getRequestAnalytics = async ({ userId, organizationId, access, dateRange }) => {
  const { filter: visibilityFilter, scope } = await requestScope({ userId, organizationId, access });
  const unit = groupingForRange(dateRange);
  const duration = dateRange.toDate.getTime() - dateRange.fromDate.getTime();
  const previousFrom = new Date(dateRange.fromDate.getTime() - duration);
  const [aggregationResults, currentCount, previousCount] = await Promise.all([
    Request.aggregate(analyticsPipeline(
      requestMatch({
        organizationId,
        visibilityFilter,
        fromDate: dateRange.fromDate,
        toDate: dateRange.toDate,
      }),
      unit
    )),
    countRequests({
      organizationId,
      visibilityFilter,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
    }),
    countRequests({
      organizationId,
      visibilityFilter,
      fromDate: previousFrom,
      toDate: dateRange.fromDate,
    }),
  ]);
  const [result = {}] = aggregationResults;

  const periods = buildPeriods(dateRange, unit);
  const countsByPeriod = new Map((result.requestTrends || []).map((item) => [
    new Date(item._id).toISOString(),
    item.count,
  ]));
  const requestTrends = periods.map((period) => ({
    period: period.period,
    periodStart: period.periodStart.toISOString(),
    count: countsByPeriod.get(period.periodStart.toISOString()) || 0,
  }));
  const statusCounts = new Map((result.statusDistribution || []).map((item) => [item._id, item.count]));
  const statusDistribution = REQUEST_STATUSES.map((status) => ({
    status,
    count: statusCounts.get(status) || 0,
  }));
  const total = (result.requestTypes || []).reduce((sum, item) => sum + item.total, 0);
  const requestTypes = (result.requestTypes || []).map((item) => {
    const statusCountsByType = new Map();
    for (const status of item.statusCounts) {
      statusCountsByType.set(status, (statusCountsByType.get(status) || 0) + 1);
    }
    return {
      requestTypeId: item.requestTypeId ? String(item.requestTypeId) : null,
      requestType: item.name || 'Unavailable request type',
      total: item.total,
      percentage: total ? Number(((item.total / total) * 100).toFixed(2)) : 0,
      statusCounts: REQUEST_STATUSES.map((status) => ({
        status,
        count: statusCountsByType.get(status) || 0,
      })),
    };
  });

  return {
    scope,
    grouping: unit.toUpperCase(),
    requestTrends,
    statusDistribution,
    requestTypes,
    requestVolumeComparison: {
      currentPeriodCount: currentCount,
      previousPeriodCount: previousCount,
      ...percentageChange(currentCount, previousCount),
    },
  };
};

export default { getRequestAnalytics };
