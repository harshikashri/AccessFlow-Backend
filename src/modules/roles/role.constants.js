import { ROLE_TYPES } from '../../config/constants.js';

export { ROLE_TYPES };
export const CREATABLE_ROLE_TYPES = ['CUSTOM'];
export const ROLE_PURPOSES = ['GENERAL', 'FINANCE_APPROVER'];
export const BUILT_IN_ROLE_TYPES = ['ORGANIZATION_ADMIN', 'DEPARTMENT_MANAGER', 'EMPLOYEE', 'FINANCE_APPROVER'];
export const PROTECTED_ROLE_TYPES = ['ORGANIZATION_ADMIN', 'EMPLOYEE'];
export const ROLE_NAME_MIN = 2;
export const ROLE_NAME_MAX = 200;
export const ROLE_DESCRIPTION_MAX = 1000;
export const ROLE_PAGE_SIZE_DEFAULT = 10;
export const ROLE_PAGE_SIZE_MAX = 100;
export const ROLE_SORT_FIELDS = ['name', 'roleType', 'status', 'createdAt', 'updatedAt'];
export const REQUIRED_ADMIN_PERMISSIONS = ['roles.view', 'roles.create', 'roles.edit'];

export const ROLE_ACTIONS = {
  CREATED: 'ROLE_CREATED',
  UPDATED: 'ROLE_UPDATED',
  PERMISSIONS_UPDATED: 'ROLE_PERMISSIONS_UPDATED',
  ACTIVATED: 'ROLE_ACTIVATED',
  DEACTIVATED: 'ROLE_DEACTIVATED',
  ASSIGNED: 'ROLE_ASSIGNED',
  UNASSIGNED: 'ROLE_UNASSIGNED',
};