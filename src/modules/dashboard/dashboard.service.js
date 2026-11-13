import { resolveEffectivePermissions } from '../../services/authorization/permission.service.js';
import { AppError } from '../../utils/AppError.js';
import { DASHBOARD_DATE_RANGE_OPTIONS, MAX_CUSTOM_DATE_RANGE_DAYS } from './dashboard.constants.js';
import { resolveDashboardWidgets } from './dashboard.permissions.js';
import { getDashboardKpis } from './dashboard.kpi.js';

const baseConfiguration = ({ dashboardType, userId, organizationId, access = null }) => ({
  dashboardType,
  userContext: {
    userId: String(userId),
    organizationId: organizationId ? String(organizationId) : null,
  },
  widgets: resolveDashboardWidgets(access, dashboardType),
  availableFilters: {
    dateRange: [...DASHBOARD_DATE_RANGE_OPTIONS],
  },
  dateRangeOptions: {
    timeZone: 'UTC',
    interval: '[fromDate, toDate)',
    maxCustomRangeDays: MAX_CUSTOM_DATE_RANGE_DAYS,
  },
});

export const resolveDashboardContext = async ({ userId, organizationId, platformRole }) => {
  if (!userId) {
    throw new AppError('Authentication is required.', 401, 'UNAUTHORIZED');
  }
  if (platformRole === 'SUPER_ADMIN') {
    if (organizationId) {
      throw new AppError('Super Admin platform sessions must not include an organization context.', 401, 'INVALID_ORGANIZATION_CONTEXT');
    }
    return { dashboardType: 'PLATFORM', userId, organizationId: null, access: null };
  }
  if (!organizationId) {
    throw new AppError('An active organization context is required.', 403, 'ORGANIZATION_CONTEXT_REQUIRED');
  }
  const access = await resolveEffectivePermissions({ userId, organizationId });
  const dashboardScopes = access.scopedPermissions.get('dashboard.view');
  if (!access.organizationPermissions.has('dashboard.view') && !dashboardScopes?.size) {
    throw new AppError('Dashboard access is not allowed.', 403, 'DASHBOARD_ACCESS_DENIED');
  }
  return { dashboardType: 'DYNAMIC', userId, organizationId, access };
};

export const getDashboardConfig = async (input) => {
  const context = await resolveDashboardContext(input);
  return baseConfiguration(context);
};

export const getDashboardSummary = async ({ userId, organizationId, platformRole, dateRange }) => {
  const context = await resolveDashboardContext({ userId, organizationId, platformRole });
  const widgets = resolveDashboardWidgets(context.access, context.dashboardType);
  const implementedProviders = new Set(
    widgets.filter((widget) => widget.kpiProvider).map((widget) => widget.kpiProvider)
  );
  const kpis = await getDashboardKpis({
    ...context,
    dateRange,
    implementedProviders,
  });
  return {
    dashboardType: context.dashboardType,
    dateRange,
    widgets,
    deferredWidgets: widgets.filter((widget) => !widget.kpiProvider && !widget.analyticsProvider)
      .map(({ key, title }) => ({ key, title })),
    kpis,
  };
};

export default { getDashboardConfig, getDashboardSummary };