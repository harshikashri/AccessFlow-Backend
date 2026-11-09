import mongoose from 'mongoose';
import Role from '../../models/Role.js';
import User from '../../models/User.js';
import Organization from '../../models/Organization.js';
import Department from '../../models/Department.js';
import UserRoleAssignment from '../../models/UserRoleAssignment.js';
import AuditLog from '../../models/AuditLog.js';
import { ORGANIZATION_ADMIN_ROLE_NAME, PERMISSION_MODULES } from '../../config/constants.js';
import { AppError } from '../../utils/AppError.js';
import { withTransaction } from '../../utils/transaction.js';
import { BUILT_IN_ROLE_TYPES, REQUIRED_ADMIN_PERMISSIONS, ROLE_ACTIONS } from './role.constants.js';
import { getRoleType } from './role-compatibility.js';
import { persistRoleAssignments, prepareRoleAssignments } from './role.assignment.service.js';
import { escapeRegex, normalizeRoleName, toPublicAssignment, toPublicRole } from './role.utils.js';

const writeAuditLog = async (session, { organizationId, actorId, action, resourceId, changes = {} }) => {
	await AuditLog.create(
		[{
			organizationId,
			actorId,
			action,
			resourceType: 'Role',
			resourceId,
			changes,
			timestamp: new Date(),
		}],
		{ session }
	);
};

const assertActiveOrganization = async (organizationId, session) => {
	let query = Organization.findById(organizationId).select('status');
	if (session) query = query.session(session);
	const organization = await query;
	if (!organization) throw new AppError('Organization not found.', 404, 'ORGANIZATION_NOT_FOUND');
	if (organization.status !== 'ACTIVE') {
		throw new AppError('This organization is inactive.', 403, 'ORGANIZATION_INACTIVE');
	}
};

const getRoleInOrganization = async ({ roleId, organizationId, session }) => {
	let query = Role.findOne({ _id: roleId, organizationId });
	if (session) query = query.session(session);
	const role = await query;
	if (!role) throw new AppError('Role not found.', 404, 'ROLE_NOT_FOUND');
	return role;
};

const ensureRoleNameAvailable = async ({ organizationId, name, exceptRoleId, session }) => {
	const filter = {
		organizationId,
		name: { $regex: `^${escapeRegex(name)}$`, $options: 'i' },
	};
	if (exceptRoleId) filter._id = { $ne: exceptRoleId };
	let query = Role.findOne(filter).select('_id');
	if (session) query = query.session(session);
	if (await query) throw new AppError('A role with this name already exists in the organization.', 409, 'ROLE_NAME_EXISTS');
};

const mapDuplicateError = (error) => {
	if (error?.code === 11000) {
		return new AppError('A role with this name already exists in the organization.', 409, 'ROLE_NAME_EXISTS');
	}
	return error;
};

const isOrganizationAdminRole = (role) => getRoleType(role) === 'ORGANIZATION_ADMIN';
const isBuiltInRole = (role) => BUILT_IN_ROLE_TYPES.includes(getRoleType(role));

const ensureAdministratorAccessRemains = async ({
	organizationId,
	session,
	changedRoleId = null,
	nextStatus,
	nextPermissions,
	excludedAssignmentId = null,
}) => {
	const roleQuery = Role.find({ organizationId });
	if (session) roleQuery.session(session);
	const roles = await roleQuery;
	const capableRoleIds = roles
		.filter((role) => {
			if (!isOrganizationAdminRole(role)) return false;
			let status = role.status;
			let permissions = role.permissions || [];
			if (changedRoleId && String(role._id) === String(changedRoleId)) {
				if (nextStatus !== undefined) status = nextStatus;
				if (nextPermissions !== undefined) permissions = nextPermissions;
			}
			return status === 'ACTIVE' && REQUIRED_ADMIN_PERMISSIONS.every((permission) => permissions.includes(permission));
		})
		.map((role) => role._id);

	let capableUsers = [];
	if (capableRoleIds.length) {
		const assignmentQuery = UserRoleAssignment.find({
			organizationId,
			roleId: { $in: capableRoleIds },
			scopeType: 'ORGANIZATION',
			departmentId: null,
			status: 'ACTIVE',
		}).select('_id userId');
		if (session) assignmentQuery.session(session);
		let assignments = await assignmentQuery;
		if (excludedAssignmentId) {
			assignments = assignments.filter((assignment) => String(assignment._id) !== String(excludedAssignmentId));
		}
		const userIds = [...new Set(assignments.map((assignment) => String(assignment.userId)))];
		if (userIds.length) {
			const usersQuery = User.find({
				_id: { $in: userIds },
				accountStatus: 'ACTIVE',
				organizationMemberships: { $elemMatch: { organizationId, status: 'ACTIVE' } },
			}).select('_id');
			if (session) usersQuery.session(session);
			capableUsers = await usersQuery;
		}
	}

	if (capableUsers.length === 0) {
		throw new AppError(
			'This change would leave the organization without an active Organization Admin who can manage roles.',
			409,
			'LAST_ORGANIZATION_ADMIN_ACCESS'
		);
	}
};

const getAssignmentForAdmin = async ({ roleId, userId, organizationId, scopeType, departmentId, session }) => {
	const filter = { roleId, userId, organizationId, scopeType, status: 'ACTIVE' };
	filter.departmentId = scopeType === 'ORGANIZATION' ? null : departmentId;
	let query = UserRoleAssignment.findOne(filter);
	if (session) query = query.session(session);
	return query;
};

export const getPermissionCatalog = () => PERMISSION_MODULES;

export const createRole = async ({ organizationId, actorId, input }) => {
	try {
		return await withTransaction(async (session) => {
			await assertActiveOrganization(organizationId, session);
			await ensureRoleNameAvailable({ organizationId, name: input.name, session });
			const role = new Role({
				organizationId,
				name: input.name,
				nameNormalized: normalizeRoleName(input.name),
				description: input.description,
				roleType: input.roleType || 'CUSTOM',
				permissions: input.permissions,
				status: 'ACTIVE',
				createdBy: actorId,
			});
			await role.save({ session });
			await writeAuditLog(session, {
				organizationId,
				actorId,
				action: ROLE_ACTIONS.CREATED,
				resourceId: role._id,
				changes: { name: role.name, description: role.description, roleType: role.roleType, permissions: role.permissions, status: role.status },
			});
			return toPublicRole(role);
		});
	} catch (error) {
		throw mapDuplicateError(error);
	}
};

export const listRoles = async ({ organizationId, page, limit, search, status, sortBy, sortOrder }) => {
	await assertActiveOrganization(organizationId);
	const filter = { organizationId };
	if (status) filter.status = status;
	if (search) filter.name = { $regex: escapeRegex(search), $options: 'i' };
	const [roles, total] = await Promise.all([
		Role.find(filter).sort({ [sortBy]: sortOrder === 'asc' ? 1 : -1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
		Role.countDocuments(filter),
	]);
	const roleIds = roles.map((role) => role._id);
	const counts = roleIds.length
		? await UserRoleAssignment.aggregate([
			{ $match: { organizationId: new mongoose.Types.ObjectId(organizationId), roleId: { $in: roleIds }, status: 'ACTIVE' } },
			{ $group: { _id: '$roleId', count: { $sum: 1 } } },
		])
		: [];
	const countMap = new Map(counts.map((item) => [String(item._id), item.count]));
	const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
	return {
		items: roles.map((role) => toPublicRole(role, countMap.get(String(role._id)) || 0)),
		pagination: { page, limit, total, totalPages, hasNextPage: page < totalPages, hasPreviousPage: page > 1 },
	};
};

export const getRoleById = async ({ roleId, organizationId }) => {
	await assertActiveOrganization(organizationId);
	const role = await getRoleInOrganization({ roleId, organizationId });
	const assignmentCount = await UserRoleAssignment.countDocuments({
		roleId,
		organizationId,
		status: 'ACTIVE',
	});
	return toPublicRole(role, assignmentCount);
};

export const updateRole = async ({ roleId, organizationId, actorId, input }) => {
	try {
		return await withTransaction(async (session) => {
			await assertActiveOrganization(organizationId, session);
			const role = await getRoleInOrganization({ roleId, organizationId, session });
			if (isBuiltInRole(role) && Object.hasOwn(input, 'name')) {
				throw new AppError('Built-in roles cannot be renamed.', 409, 'BUILT_IN_ROLE_PROTECTED');
			}
			if (Object.hasOwn(input, 'name') && input.name.toLowerCase() !== role.name.toLowerCase()) {
				await ensureRoleNameAvailable({ organizationId, name: input.name, exceptRoleId: role._id, session });
			}
			const changes = {};
			for (const [field, value] of Object.entries(input)) {
				if (role[field] !== value) {
					changes[field] = { from: role[field], to: value };
					role[field] = value;
				}
			}
			if (Object.hasOwn(input, 'name')) {
				role.nameNormalized = normalizeRoleName(input.name);
			}
			if (isOrganizationAdminRole(role)) role.roleType = 'ORGANIZATION_ADMIN';
			if (Object.keys(changes).length === 0) return toPublicRole(role);
			await role.save({ session });
			await writeAuditLog(session, { organizationId, actorId, action: ROLE_ACTIONS.UPDATED, resourceId: role._id, changes });
			return toPublicRole(role);
		});
	} catch (error) {
		throw mapDuplicateError(error);
	}
};

export const updateRolePermissions = async ({ roleId, organizationId, actorId, permissions }) =>
	withTransaction(async (session) => {
		await assertActiveOrganization(organizationId, session);
		const role = await getRoleInOrganization({ roleId, organizationId, session });
		const previousPermissions = [...(role.permissions || [])];
		if (isBuiltInRole(role) && getRoleType(role) !== 'DEPARTMENT_MANAGER') {
			throw new AppError('This built-in role does not allow permission changes.', 409, 'BUILT_IN_ROLE_PROTECTED');
		}
		if (JSON.stringify(previousPermissions) === JSON.stringify(permissions)) return toPublicRole(role);
		if (isOrganizationAdminRole(role)) {
			await ensureAdministratorAccessRemains({
				organizationId,
				session,
				changedRoleId: role._id,
				nextPermissions: permissions,
			});
		}
		role.permissions = permissions;
		if (isOrganizationAdminRole(role)) role.roleType = 'ORGANIZATION_ADMIN';
		await role.save({ session });
		await writeAuditLog(session, {
			organizationId,
			actorId,
			action: ROLE_ACTIONS.PERMISSIONS_UPDATED,
			resourceId: role._id,
			changes: { permissions: { from: previousPermissions, to: permissions } },
		});
		return toPublicRole(role);
	});

export const setRoleStatus = async ({ roleId, organizationId, actorId, status }) =>
	withTransaction(async (session) => {
		await assertActiveOrganization(organizationId, session);
		const role = await getRoleInOrganization({ roleId, organizationId, session });
		if (role.status === status) return toPublicRole(role);
		if (isBuiltInRole(role)) {
			throw new AppError('Built-in roles cannot be activated or deactivated through role management.', 409, 'BUILT_IN_ROLE_PROTECTED');
		}
		if (status === 'INACTIVE') {
			await ensureAdministratorAccessRemains({
				organizationId,
				session,
				changedRoleId: role._id,
				nextStatus: status,
			});
		}
		const previousStatus = role.status;
		role.status = status;
		await role.save({ session });
		await writeAuditLog(session, {
			organizationId,
			actorId,
			action: status === 'ACTIVE' ? ROLE_ACTIONS.ACTIVATED : ROLE_ACTIONS.DEACTIVATED,
			resourceId: role._id,
			changes: { status: { from: previousStatus, to: status } },
		});
		return toPublicRole(role);
	});

export const assignRole = async ({ roleId, organizationId, actorId, access, input }) =>
	withTransaction(async (session) => {
		await assertActiveOrganization(organizationId, session);
		const role = await getRoleInOrganization({ roleId, organizationId, session });
		if (role.status !== 'ACTIVE') throw new AppError('Inactive roles cannot be assigned.', 409, 'ROLE_INACTIVE');
		const [prepared] = await prepareRoleAssignments({
			assignments: [{ ...input, roleId: role._id }],
			organizationId,
			access,
			session,
			userId: input.userId,
		});
		const [assignment] = await persistRoleAssignments({
			assignments: [prepared],
			userId: input.userId,
			organizationId,
			actorId,
			session,
		});
		await writeAuditLog(session, {
			organizationId,
			actorId,
			action: ROLE_ACTIONS.ASSIGNED,
			resourceId: role._id,
			changes: {
				assignmentId: String(assignment._id),
				userId: String(input.userId),
				scopeType: input.scopeType,
				departmentId: input.departmentId ? String(input.departmentId) : null,
			},
		});
		return toPublicAssignment(assignment);
	});

export const removeRoleAssignment = async ({ roleId, userId, organizationId, actorId, scope }) =>
	withTransaction(async (session) => {
		await assertActiveOrganization(organizationId, session);
		const role = await getRoleInOrganization({ roleId, organizationId, session });
		const assignment = await getAssignmentForAdmin({
			roleId: role._id,
			userId,
			organizationId,
			scopeType: scope.scopeType,
			departmentId: scope.departmentId,
			session,
		});
		if (!assignment) throw new AppError('Active role assignment not found.', 404, 'ROLE_ASSIGNMENT_NOT_FOUND');

		if (isOrganizationAdminRole(role)) {
			await ensureAdministratorAccessRemains({
				organizationId,
				session,
				excludedAssignmentId: assignment._id,
			});
		}
		assignment.status = 'INACTIVE';
		await assignment.save({ session });
		await writeAuditLog(session, {
			organizationId,
			actorId,
			action: ROLE_ACTIONS.UNASSIGNED,
			resourceId: role._id,
			changes: {
				assignmentId: String(assignment._id),
				userId: String(userId),
				scopeType: assignment.scopeType,
				departmentId: assignment.departmentId ? String(assignment.departmentId) : null,
				status: { from: 'ACTIVE', to: 'INACTIVE' },
			},
		});
		return { assignmentId: String(assignment._id), status: assignment.status };
	});

export const listUserRoleAssignments = async ({ userId, organizationId, page, limit }) => {
	await assertActiveOrganization(organizationId);
	const user = await User.findOne({
		_id: userId,
		'organizationMemberships.organizationId': organizationId,
	}).select('_id');
	if (!user) throw new AppError('User not found.', 404, 'USER_NOT_FOUND');
	const filter = { userId, organizationId };
	const [assignments, total] = await Promise.all([
		UserRoleAssignment.find(filter)
			.sort({ assignedAt: -1, _id: 1 })
			.skip((page - 1) * limit)
			.limit(limit)
			.populate({ path: 'roleId', select: 'name roleType permissions status' })
			.populate({ path: 'departmentId', select: 'name status' })
			.lean(),
		UserRoleAssignment.countDocuments(filter),
	]);
	return {
		items: assignments.map(toPublicAssignment),
		pagination: { page, limit, total, totalPages: total ? Math.ceil(total / limit) : 0 },
	};
};

export const listRoleUsers = async ({ roleId, organizationId, page, limit }) => {
	await assertActiveOrganization(organizationId);
	await getRoleInOrganization({ roleId, organizationId });
	const filter = { roleId, organizationId };
	const [assignments, total] = await Promise.all([
		UserRoleAssignment.find(filter)
			.sort({ assignedAt: -1, _id: 1 })
			.skip((page - 1) * limit)
			.limit(limit)
			.populate({ path: 'userId', select: 'name email accountStatus' })
			.populate({ path: 'roleId', select: 'name roleType status' })
			.populate({ path: 'departmentId', select: 'name status' })
			.lean(),
		UserRoleAssignment.countDocuments(filter),
	]);
	return {
		items: assignments.filter((assignment) => assignment.userId).map(toPublicAssignment),
		pagination: { page, limit, total, totalPages: total ? Math.ceil(total / limit) : 0 },
	};
};

export default {
	getPermissionCatalog,
	createRole,
	listRoles,
	getRoleById,
	updateRole,
	updateRolePermissions,
	setRoleStatus,
	assignRole,
	removeRoleAssignment,
	listUserRoleAssignments,
	listRoleUsers,
};
