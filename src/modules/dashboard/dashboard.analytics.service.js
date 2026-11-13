import { resolveDashboardContext } from './dashboard.service.js';
import { getRequestAnalytics } from './analytics/request.analytics.js';
import { getApprovalAnalytics } from './analytics/approval.analytics.js';
import { getDepartmentAnalytics } from './analytics/department.analytics.js';
import { getTenantUserAnalytics } from './analytics/user.analytics.js';
import { getRecentActivity } from './analytics/activity.analytics.js';
import { AppError } from '../../utils/AppError.js';
import {
  getPlatformDepartmentAnalytics,
  getPlatformOrganizationAnalytics,
  getPlatformRecentActivity,
  getPlatformRequestAnalytics,
  getPlatformUserAnalytics,
} from './analytics/platform.analytics.js';

export const requestAnalytics = async ({ userId, organizationId, platformRole, dateRange }) => {
  const context = await resolveDashboardContext({ userId, organizationId, platformRole });
  if (context.dashboardType === 'PLATFORM') {
    return getPlatformRequestAnalytics(dateRange);
  }
  return {
    dateRange,
    ...(await getRequestAnalytics({ ...context, dateRange })),
  };
};

export const approvalAnalytics = async ({ userId, organizationId, platformRole, dateRange }) => {
  const context = await resolveDashboardContext({ userId, organizationId, platformRole });
  if (context.dashboardType === 'PLATFORM') {
    throw new AppError('Platform administrators do not have approval analytics access.', 403, 'FORBIDDEN');
  }
  return {
    dateRange,
    ...(await getApprovalAnalytics({ ...context, dateRange })),
  };
};

export const departmentAnalytics = async ({ userId, organizationId, platformRole, dateRange }) => {
  const context = await resolveDashboardContext({ userId, organizationId, platformRole });
  if (context.dashboardType === 'PLATFORM') {
    return getPlatformDepartmentAnalytics(dateRange);
  }
  return {
    dateRange,
    ...(await getDepartmentAnalytics({ ...context, dateRange })),
  };
};

export const recentActivity = async ({
  userId,
  organizationId,
  platformRole,
  dateRange,
  page,
  limit,
}) => {
  const context = await resolveDashboardContext({ userId, organizationId, platformRole });
  if (context.dashboardType === 'PLATFORM') {
    return getPlatformRecentActivity({ dateRange, page, limit });
  }
  return {
    dateRange,
    ...(await getRecentActivity({ ...context, platformRole, dateRange, page, limit })),
  };
};

export const organizationAnalytics = async ({ userId, organizationId, platformRole, dateRange }) => {
  const context = await resolveDashboardContext({ userId, organizationId, platformRole });
  if (context.dashboardType !== 'PLATFORM') {
    throw new AppError('Platform analytics require Super Admin access.', 403, 'FORBIDDEN');
  }
  return getPlatformOrganizationAnalytics(dateRange);
};

export const userAnalytics = async ({ userId, organizationId, platformRole, dateRange }) => {
  const context = await resolveDashboardContext({ userId, organizationId, platformRole });
  if (context.dashboardType === 'PLATFORM') {
    return getPlatformUserAnalytics(dateRange);
  }
  return {
    dateRange,
    ...(await getTenantUserAnalytics({ ...context, dateRange })),
  };
};

export default {
  requestAnalytics,
  approvalAnalytics,
  departmentAnalytics,
  organizationAnalytics,
  userAnalytics,
  recentActivity,
};

