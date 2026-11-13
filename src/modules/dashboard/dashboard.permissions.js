import { TENANT_WIDGETS, PLATFORM_WIDGETS } from './dashboard.registry.js';

const permissionScopes = (access, permission) => ({
  organization: access.organizationPermissions.has(permission),
  departments: access.scopedPermissions.get(permission) || new Set(),
});

const hasPermission = (access, permission) => {
  const scopes = permissionScopes(access, permission);
  return scopes.organization || scopes.departments.size > 0;
};

const isOrganizationAdmin = (access) => access.assignments.some(
  (assignment) => assignment.roleId?.roleType === 'ORGANIZATION_ADMIN'
);

const isPersonalHistoryOnly = (access) => access.assignments.some(
  (assignment) => ['DEPARTMENT_MANAGER', 'EMPLOYEE'].includes(assignment.roleId?.roleType)
);

const canViewRoleOverview = (access) =>
  access.organizationPermissions.has('roles.view') &&
  access.assignments.some((assignment) =>
    assignment.scopeType === 'ORGANIZATION' &&
    !assignment.departmentId &&
    assignment.roleId?.roleType === 'ORGANIZATION_ADMIN'
  );

const resolveScope = (access, widget) => {
  if (widget.scopeMode === 'PLATFORM') return 'PLATFORM';
  if (widget.scopeMode === 'REQUEST_HISTORY') {
    const organizationRequestView = access.assignments.some((assignment) =>
      assignment.roleId?.roleType === 'CUSTOM' &&
      assignment.scopeType === 'ORGANIZATION' &&
      !assignment.departmentId &&
      assignment.roleId.permissions?.includes('requests.view')
    );
    if (!isPersonalHistoryOnly(access) &&
        ((isOrganizationAdmin(access) && permissionScopes(access, 'requests.view').organization) ||
          organizationRequestView)) return 'ORGANIZATION';
    const departmentRequestView = access.assignments.some((assignment) =>
      !isPersonalHistoryOnly(access) &&
      assignment.roleId?.roleType === 'CUSTOM' &&
      assignment.scopeType === 'DEPARTMENT' &&
      assignment.roleId.permissions?.includes('requests.view')
    );
    return departmentRequestView ? 'DEPARTMENT' : 'AUTHORIZED_REQUEST_HISTORY';
  }
  if (widget.scopeMode === 'APPROVAL_ASSIGNMENTS') {
    return isOrganizationAdmin(access) && permissionScopes(access, 'requests.approve').organization
      ? 'ORGANIZATION'
      : 'AUTHORIZED_APPROVAL_ASSIGNMENTS';
  }
  return widget.requiredPermissions.some((permission) =>
    permissionScopes(access, permission).organization
  ) ? 'ORGANIZATION' : 'DEPARTMENT';
};

export const resolveDashboardWidgets = (access, dashboardType = 'DYNAMIC') => {
  const registry = dashboardType === 'PLATFORM' ? PLATFORM_WIDGETS : TENANT_WIDGETS;
  return registry
    .filter((widget) => widget.requiredPermissions.every((permission) => hasPermission(access, permission)))
    .filter((widget) => widget.key !== 'ROLE_OVERVIEW' || canViewRoleOverview(access))
    .map((widget) => ({
      key: widget.key,
      title: widget.title,
      description: widget.description,
      category: widget.category,
      scope: resolveScope(access, widget),
      supportedFilters: [...widget.supportedFilters],
      kpiProvider: widget.kpiProvider,
      kpiStatus: widget.kpiProvider ? 'IMPLEMENTED' : 'DEFERRED',
      analyticsProvider: widget.analyticsProvider,
      analyticsStatus: widget.analyticsProvider ? 'IMPLEMENTED' : 'DEFERRED',
    }));
};

export default { resolveDashboardWidgets };
