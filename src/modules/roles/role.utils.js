import { getRoleType } from './role-compatibility.js';
import { getSupportedRoleScopes } from './role.scope.js';

export const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const normalizeRoleName = (value) => value.trim().toLocaleLowerCase('en-US');

export const toPublicRole = (role, assignmentCount = 0) => {
  const assignmentScopes = getSupportedRoleScopes(role);
  return ({
  id: String(role._id),
  organizationId: String(role.organizationId),
  name: role.name,
  description: role.description,
  roleType: getRoleType(role),
  rolePurpose: role.rolePurpose || 'GENERAL',
  assignmentScope: assignmentScopes.length === 1 ? assignmentScopes[0] : null,
  assignmentScopes,
  permissions: role.permissions || [],
  status: role.status,
  createdBy: role.createdBy ? String(role.createdBy) : null,
  createdAt: role.createdAt,
  updatedAt: role.updatedAt,
  assignmentCount,
  });
};

export const toPublicAssignment = (assignment) => {
  const assignmentScopes = assignment.roleId ? getSupportedRoleScopes(assignment.roleId) : [];
  return ({
  id: String(assignment._id),
  userId: String(assignment.userId?._id || assignment.userId),
  user: assignment.userId && assignment.userId.name
    ? {
      id: String(assignment.userId._id),
      name: assignment.userId.name,
      email: assignment.userId.email,
      accountStatus: assignment.userId.accountStatus,
    }
    : undefined,
  roleId: String(assignment.roleId?._id || assignment.roleId),
  roleName: assignment.roleId?.name || undefined,
  assignmentScope: assignmentScopes.length === 1 ? assignmentScopes[0] : null,
  assignmentScopes,
  scopeType: assignment.scopeType,
  departmentId: assignment.departmentId ? String(assignment.departmentId._id || assignment.departmentId) : null,
  departmentName: assignment.departmentId?.name || undefined,
  status: assignment.status,
  assignedBy: assignment.assignedBy ? String(assignment.assignedBy) : null,
  assignedAt: assignment.assignedAt,
  });
};

export default { escapeRegex, normalizeRoleName, toPublicRole, toPublicAssignment };