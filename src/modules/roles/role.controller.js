import { AppError } from '../../utils/AppError.js';
import * as roleService from './role.service.js';
import {
	validateAssignmentScope,
	validateCreateRole,
	validatePaginationQuery,
	validatePermissionUpdate,
	validateRoleAssignment,
	validateRoleId,
	validateRoleListQuery,
	validateUpdateRole,
} from './role.validation.js';

export const createRole = async (req, res) => {
	const input = validateCreateRole(req.body);
	const role = await roleService.createRole({
		organizationId: req.auth.organizationId,
		actorId: req.auth.userId,
		input,
	});
	return res.status(201).json({ success: true, message: 'Role created successfully.', data: role });
};

export const listRoles = async (req, res) => {
	const query = validateRoleListQuery(req.query);
	const result = await roleService.listRoles({ organizationId: req.auth.organizationId, ...query });
	return res.status(200).json({ success: true, message: 'Roles retrieved successfully.', data: result });
};

export const getRole = async (req, res) => {
	const roleId = validateRoleId(req.params.roleId);
	const role = await roleService.getRoleById({ roleId, organizationId: req.auth.organizationId });
	return res.status(200).json({ success: true, message: 'Role retrieved successfully.', data: role });
};

export const updateRole = async (req, res) => {
	const roleId = validateRoleId(req.params.roleId);
	const input = validateUpdateRole(req.body);
	const role = await roleService.updateRole({
		roleId,
		organizationId: req.auth.organizationId,
		actorId: req.auth.userId,
		input,
	});
	return res.status(200).json({ success: true, message: 'Role updated successfully.', data: role });
};

export const updateRolePermissions = async (req, res) => {
	const roleId = validateRoleId(req.params.roleId);
	const { permissions } = validatePermissionUpdate(req.body);
	const role = await roleService.updateRolePermissions({
		roleId,
		organizationId: req.auth.organizationId,
		actorId: req.auth.userId,
		permissions,
	});
	return res.status(200).json({ success: true, message: 'Role permissions updated successfully.', data: role });
};

export const getPermissionCatalog = async (req, res) =>
	res.status(200).json({
		success: true,
		message: 'Permission catalog retrieved successfully.',
		data: { modules: roleService.getPermissionCatalog() },
	});

export const activateRole = async (req, res) => {
	const roleId = validateRoleId(req.params.roleId);
	const role = await roleService.setRoleStatus({
		roleId,
		organizationId: req.auth.organizationId,
		actorId: req.auth.userId,
		status: 'ACTIVE',
	});
	return res.status(200).json({ success: true, message: 'Role activated successfully.', data: role });
};

export const deactivateRole = async (req, res) => {
	const roleId = validateRoleId(req.params.roleId);
	const role = await roleService.setRoleStatus({
		roleId,
		organizationId: req.auth.organizationId,
		actorId: req.auth.userId,
		status: 'INACTIVE',
	});
	return res.status(200).json({ success: true, message: 'Role deactivated successfully.', data: role });
};

export const assignRole = async (req, res) => {
	const roleId = validateRoleId(req.params.roleId);
	const input = validateRoleAssignment(req.body);
	const assignment = await roleService.assignRole({
		roleId,
		organizationId: req.auth.organizationId,
		actorId: req.auth.userId,
		access: req.roleAccess,
		input,
	});
	return res.status(201).json({ success: true, message: 'Role assigned successfully.', data: assignment });
};

export const removeRoleAssignment = async (req, res) => {
	const roleId = validateRoleId(req.params.roleId);
	const userId = validateRoleId(req.params.userId, 'userId');
	const scope = validateAssignmentScope(req.body);
	const result = await roleService.removeRoleAssignment({
		roleId,
		userId,
		organizationId: req.auth.organizationId,
		actorId: req.auth.userId,
		scope,
	});
	return res.status(200).json({ success: true, message: 'Role assignment removed successfully.', data: result });
};

export const listUserRoleAssignments = async (req, res) => {
	const userId = validateRoleId(req.params.userId, 'userId');
	const query = validatePaginationQuery(req.query);
	const result = await roleService.listUserRoleAssignments({
		userId,
		organizationId: req.auth.organizationId,
		...query,
	});
	return res.status(200).json({ success: true, message: 'User role assignments retrieved successfully.', data: result });
};

export const listRoleUsers = async (req, res) => {
	const roleId = validateRoleId(req.params.roleId);
	const query = validatePaginationQuery(req.query);
	const result = await roleService.listRoleUsers({
		roleId,
		organizationId: req.auth.organizationId,
		...query,
	});
	return res.status(200).json({ success: true, message: 'Role users retrieved successfully.', data: result });
};

export default {
	createRole,
	listRoles,
	getRole,
	updateRole,
	updateRolePermissions,
	getPermissionCatalog,
	activateRole,
	deactivateRole,
	assignRole,
	removeRoleAssignment,
	listUserRoleAssignments,
	listRoleUsers,
};
