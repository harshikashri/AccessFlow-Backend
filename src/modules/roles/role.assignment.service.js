import mongoose from 'mongoose';
import Department from '../../models/Department.js';
import Role from '../../models/Role.js';
import User from '../../models/User.js';
import UserRoleAssignment from '../../models/UserRoleAssignment.js';
import { AppError } from '../../utils/AppError.js';
import { getScopedDepartmentIds } from '../users/user.utils.js';
import { assertRoleCompatibility, getRoleType } from './role-compatibility.js';

const assertCanAssignRole = (role, requestedAssignment, access) => {
  if (!access) return;

  const hasPermission = (permission) =>
    access.organizationPermissions.has(permission) ||
    (requestedAssignment.scopeType === 'DEPARTMENT' &&
      getScopedDepartmentIds(access, permission).includes(String(requestedAssignment.departmentId)));

  const roleType = getRoleType(role);
  if (roleType === 'EMPLOYEE' || roleType === 'DEPARTMENT_MANAGER') {
    const allowedPermissions = roleType === 'EMPLOYEE'
      ? ['roles.edit', 'users.create', 'users.edit']
      : ['roles.edit'];
    if (allowedPermissions.some(hasPermission)) return;
    throw new AppError(
      'You are not authorized to assign this built-in role.',
      403,
      'ROLE_ASSIGNMENT_FORBIDDEN',
      { roleId: String(role._id) }
    );
  }

  const permissions = role.permissions || [];
  if (permissions.some((permission) => !hasPermission(permission))) {
    throw new AppError(
      'You cannot assign a role with permissions beyond your own effective scope.',
      403,
      'ROLE_ASSIGNMENT_FORBIDDEN',
      { roleId: String(role._id) }
    );
  }
};

const assertRoleScopeType = (role, scopeType) => {
  const roleType = getRoleType(role);
  if (roleType === 'ORGANIZATION_ADMIN' && scopeType !== 'ORGANIZATION') {
    throw new AppError('Organization Admin roles must be assigned at organization scope.', 400, 'INVALID_ROLE_SCOPE');
  }
  if (roleType === 'DEPARTMENT_MANAGER' && scopeType !== 'DEPARTMENT') {
    throw new AppError('Department Manager roles must be assigned at department scope.', 400, 'INVALID_ROLE_SCOPE');
  }
};

const getActiveRoleAssignments = async ({ userId, organizationId, session }) => {
  let query = UserRoleAssignment.find({ userId, organizationId, status: 'ACTIVE' })
    .populate({ path: 'roleId', select: 'organizationId name roleType status permissions' });
  if (session) query = query.session(session);
  return query;
};

const validateAssignableUser = async ({ userId, organizationId, session }) => {
  let query = User.findOne({
    _id: userId,
    accountStatus: 'ACTIVE',
    organizationMemberships: { $elemMatch: { organizationId, status: 'ACTIVE' } },
  }).select('_id');
  if (session) query = query.session(session);
  if (!(await query)) {
    throw new AppError('User must have an active account and organization membership.', 400, 'INVALID_ROLE_USER');
  }
};

const validateAssignmentDepartment = async ({ departmentId, organizationId, session }) => {
  if (!departmentId) return;
  let query = Department.findOne({ _id: departmentId, organizationId, status: 'ACTIVE' }).select('_id');
  if (session) query = query.session(session);
  if (!(await query)) {
    throw new AppError('Department must be active and belong to this organization.', 400, 'INVALID_ROLE_DEPARTMENT');
  }
};

export const prepareRoleAssignments = async ({
  assignments,
  organizationId,
  access,
  session,
  userId = null,
}) => {
  if (!assignments.length) return [];

  const roleIds = [...new Set(assignments.map((item) => String(item.roleId)))].map(
    (id) => new mongoose.Types.ObjectId(id)
  );
  let roleQuery = Role.find({ _id: { $in: roleIds }, organizationId, status: 'ACTIVE' });
  if (session) roleQuery = roleQuery.session(session);
  const roles = await roleQuery;
  const rolesById = new Map(roles.map((role) => [String(role._id), role]));
  if (rolesById.size !== roleIds.length) {
    throw new AppError(
      'Every role must exist, be active, and belong to this organization.',
      400,
      'INVALID_ROLE_ASSIGNMENT'
    );
  }

  for (const assignment of assignments) {
    const role = rolesById.get(String(assignment.roleId));
    assertRoleScopeType(role, assignment.scopeType);
    assertCanAssignRole(role, assignment, access);
    await validateAssignmentDepartment({
      departmentId: assignment.departmentId,
      organizationId,
      session,
    });
  }

  if (userId) {
    await validateAssignableUser({ userId, organizationId, session });
    const existing = await getActiveRoleAssignments({ userId, organizationId, session });
    const comparableExisting = existing
      .filter((assignment) => assignment.roleId && assignment.roleId.status === 'ACTIVE')
      .map((assignment) => ({
        role: assignment.roleId,
        scopeType: assignment.scopeType,
        departmentId: assignment.departmentId,
      }));
    assertRoleCompatibility(
      comparableExisting,
      assignments.map((assignment) => ({
        ...assignment,
        role: rolesById.get(String(assignment.roleId)),
      }))
    );
  } else {
    assertRoleCompatibility(
      [],
      assignments.map((assignment) => ({
        ...assignment,
        role: rolesById.get(String(assignment.roleId)),
      }))
    );
  }

  return assignments.map((assignment) => ({
    ...assignment,
    role: rolesById.get(String(assignment.roleId)),
    roleId: new mongoose.Types.ObjectId(assignment.roleId),
    departmentId: assignment.departmentId ? new mongoose.Types.ObjectId(assignment.departmentId) : null,
  }));
};

export const getBuiltInRole = async ({ organizationId, roleType, session }) => {
  let query = Role.findOne({ organizationId, roleType, status: 'ACTIVE' });
  if (session) query = query.session(session);
  const role = await query;
  if (!role) {
    throw new AppError(`The ${roleType} default role is not provisioned.`, 409, 'BUILT_IN_ROLE_MISSING');
  }
  return role;
};

export const persistRoleAssignments = async ({
  assignments,
  userId,
  organizationId,
  actorId,
  session,
}) => {
  if (!assignments.length) return [];

  const duplicate = await UserRoleAssignment.findOne({
    userId,
    organizationId,
    status: 'ACTIVE',
    $or: assignments.map((assignment) => ({
      roleId: assignment.roleId,
      scopeType: assignment.scopeType,
      departmentId: assignment.scopeType === 'ORGANIZATION' ? null : assignment.departmentId,
    })),
  }).session(session);
  if (duplicate) {
    throw new AppError(
      'This role is already assigned at the requested scope.',
      409,
      'ROLE_ASSIGNMENT_EXISTS'
    );
  }

  const documents = assignments.map((assignment) => ({
    userId,
    roleId: assignment.roleId,
    organizationId,
    departmentId: assignment.departmentId,
    scopeType: assignment.scopeType,
    status: 'ACTIVE',
    assignedBy: actorId,
    assignedAt: new Date(),
  }));
  return UserRoleAssignment.create(documents, { session, ordered: true });
};

export const ensureEmployeeDepartmentAssignment = async ({
  userId,
  organizationId,
  departmentId,
  role,
  actorId,
  access,
  session,
}) => {
  if (getRoleType(role) !== 'EMPLOYEE') {
    throw new AppError(
      'Only the built-in Employee role can be ensured through department membership.',
      400,
      'INVALID_EMPLOYEE_ROLE'
    );
  }

  const prepared = await prepareRoleAssignments({
    assignments: [{ roleId: role._id, scopeType: 'DEPARTMENT', departmentId }],
    organizationId,
    access,
    session,
    userId,
  });
  const existing = await UserRoleAssignment.findOne({
    userId,
    organizationId,
    roleId: role._id,
    scopeType: 'DEPARTMENT',
    departmentId,
    status: 'ACTIVE',
  }).session(session);
  if (existing) return existing;

  const [created] = await persistRoleAssignments({
    assignments: prepared,
    userId,
    organizationId,
    actorId,
    session,
  });
  return created;
};

export const ensureDepartmentManagerAssignment = async ({
  userId,
  organizationId,
  departmentId,
  role,
  actorId,
  access,
  session,
}) => {
  if (getRoleType(role) !== 'DEPARTMENT_MANAGER') {
    throw new AppError(
      'Only the built-in Department Manager role can be ensured through department manager registration.',
      400,
      'INVALID_DEPARTMENT_MANAGER_ROLE'
    );
  }

  const organizationScopedAssignment = await UserRoleAssignment.findOne({
    userId,
    organizationId,
    roleId: role._id,
    scopeType: 'ORGANIZATION',
    status: 'ACTIVE',
  }).session(session);
  if (organizationScopedAssignment) {
    throw new AppError(
      'Department Manager roles must be assigned at department scope.',
      400,
      'INVALID_ROLE_SCOPE'
    );
  }

  const prepared = await prepareRoleAssignments({
    assignments: [{ roleId: role._id, scopeType: 'DEPARTMENT', departmentId }],
    organizationId,
    access,
    session,
    userId,
  });
  const existing = await UserRoleAssignment.findOne({
    userId,
    organizationId,
    roleId: role._id,
    scopeType: 'DEPARTMENT',
    departmentId,
    status: 'ACTIVE',
  }).session(session);
  if (existing) return { assignment: existing, created: false };

  const [assignment] = await persistRoleAssignments({
    assignments: prepared,
    userId,
    organizationId,
    actorId,
    session,
  });
  return { assignment, created: true };
};

export default {
  getBuiltInRole,
  prepareRoleAssignments,
  persistRoleAssignments,
  ensureEmployeeDepartmentAssignment,
  ensureDepartmentManagerAssignment,
};
