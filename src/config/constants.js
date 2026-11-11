import { PERMISSION_CATALOG, PERMISSION_MODULES } from './permissionCatalog.js';

export const REQUEST_TYPES = ['PURCHASE', 'LEAVE', 'ACCESS', 'RESOURCE', 'GENERAL'];

export const REQUEST_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'CANCELLED',
  'PENDING_APPROVAL',
  'RETURNED',
  'REJECTED',
  'APPROVED',
];

export const REQUEST_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
export const REQUEST_DEFINITION_TYPES = ['REQUEST_TYPE', 'APPROVAL_WORKFLOW'];
export const REQUEST_FIELD_TYPES = ['TEXT', 'TEXTAREA', 'NUMBER', 'DATE', 'SELECT', 'MULTI_SELECT', 'CHECKBOX'];

export const ENTITY_STATUS = ['ACTIVE', 'INACTIVE'];

export const APPROVER_TYPES = ['DEPARTMENT_MANAGER', 'ROLE', 'USER', 'ORGANIZATION_ADMIN'];

export const APPROVAL_STATUSES = ['PENDING', 'ACTIVE', 'CLAIMED', 'APPROVED', 'REJECTED', 'RETURNED', 'SKIPPED', 'CANCELLED'];

export const SCOPE_TYPES = ['ORGANIZATION', 'DEPARTMENT'];
export const ROLE_TYPES = ['ORGANIZATION_ADMIN', 'DEPARTMENT_MANAGER', 'EMPLOYEE', 'FINANCE_APPROVER', 'CUSTOM'];

export const CONDITIONAL_OPERATORS = ['GREATER_THAN', 'LESS_THAN', 'EQUALS'];

export { PERMISSION_CATALOG, PERMISSION_MODULES };

export const ORGANIZATION_ADMIN_ROLE_NAME = 'Organization Admin';
export const DEPARTMENT_MANAGER_ROLE_NAME = 'Department Manager';
export const DEPARTMENT_MEMBER_ROLE_NAME = 'Department Member';

/**
 * Organization Admin receives existing catalog permissions only.
 * Platform organization-management remains Super Admin via platformRole,
 * not permission codes (no organizations.* codes exist in the catalog).
 */
export const ORGANIZATION_ADMIN_PERMISSIONS = [...PERMISSION_CATALOG];
export const DEPARTMENT_MANAGER_PERMISSIONS = [
  'users.view',
  'users.edit',
  'departments.view',
  'departments.edit',
  'requests.view',
  'requests.approve',
  'dashboard.view',
];
export const DEPARTMENT_MEMBER_PERMISSIONS = [
  'users.view',
  'requests.view',
  'requests.create',
  'requests.edit_own_draft',
  'requests.submit',
  'requests.cancel_own',
  'dashboard.view',
];

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
