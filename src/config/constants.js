export const REQUEST_TYPES = ['PURCHASE', 'LEAVE', 'ACCESS', 'GENERAL'];

export const REQUEST_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'PENDING_APPROVAL',
  'RETURNED',
  'REJECTED',
  'APPROVED',
  'CANCELLED',
];

export const ENTITY_STATUS = ['ACTIVE', 'INACTIVE'];

export const APPROVER_TYPES = ['DEPARTMENT_MANAGER', 'ROLE', 'USER'];

export const APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'RETURNED', 'SKIPPED'];

export const SCOPE_TYPES = ['ORGANIZATION', 'DEPARTMENT'];

export const CONDITIONAL_OPERATORS = ['GREATER_THAN', 'LESS_THAN', 'EQUALS'];

export const PERMISSION_CATALOG = [
  'users.view',
  'users.create',
  'users.edit',
  'users.deactivate',
  'departments.view',
  'departments.create',
  'departments.edit',
  'roles.view',
  'roles.create',
  'roles.edit',
  'requests.view',
  'requests.create',
  'requests.approve',
  'workflows.view',
  'workflows.manage',
  'audit_logs.view',
  'dashboard.view',
];

export const ORGANIZATION_ADMIN_ROLE_NAME = 'Organization Admin';

/**
 * Organization Admin receives existing catalog permissions only.
 * Platform organization-management remains Super Admin via platformRole,
 * not permission codes (no organizations.* codes exist in the catalog).
 */
export const ORGANIZATION_ADMIN_PERMISSIONS = [...PERMISSION_CATALOG];

export const AUDIT_ACTIONS = {
  ORGANIZATION_CREATED: 'ORGANIZATION_CREATED',
  ORGANIZATION_UPDATED: 'ORGANIZATION_UPDATED',
  ORGANIZATION_ACTIVATED: 'ORGANIZATION_ACTIVATED',
  ORGANIZATION_DEACTIVATED: 'ORGANIZATION_DEACTIVATED',
  ORGANIZATION_ADMIN_CREATED: 'ORGANIZATION_ADMIN_CREATED',
};

export const AUDIT_RESOURCE_TYPES = {
  ORGANIZATION: 'Organization',
  USER: 'User',
};
