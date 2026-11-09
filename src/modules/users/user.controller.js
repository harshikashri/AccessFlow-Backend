import { AppError } from '../../utils/AppError.js';
import * as userService from './user.service.js';
import {
	validateCreateUser,
	validateDepartmentAssignment,
	validateUserId,
	validateUserListQuery,
	validateUpdateUser,
} from './user.validation.js';

export const createUser = async (req, res) => {
	const input = validateCreateUser(req.body);
	const user = await userService.createUser({
		organizationId: req.auth.organizationId,
		actorId: req.auth.userId,
		access: req.userAccess,
		input,
	});
	return res.status(201).json({
		success: true,
		message: 'User created. Password setup instructions have been sent.',
		data: user,
	});
};

export const listUsers = async (req, res) => {
	const query = validateUserListQuery(req.query);
	const result = await userService.listUsers({
		...query,
		organizationId: req.auth.organizationId,
		access: req.userAccess,
	});
	return res.status(200).json({ success: true, message: 'Users retrieved successfully.', data: result });
};

export const getUser = async (req, res) => {
	const userId = validateUserId(req.params.userId);
	const user = await userService.getUserById({
		userId,
		organizationId: req.auth.organizationId,
		access: req.userAccess,
	});
	return res.status(200).json({ success: true, message: 'User retrieved successfully.', data: user });
};

export const updateUser = async (req, res) => {
	const userId = validateUserId(req.params.userId);
	const input = validateUpdateUser(req.body);
	const user = await userService.updateUser({
		userId,
		organizationId: req.auth.organizationId,
		actorId: req.auth.userId,
		access: req.userAccess,
		input,
	});
	return res.status(200).json({ success: true, message: 'User updated successfully.', data: user });
};

export const assignDepartment = async (req, res) => {
	const userId = validateUserId(req.params.userId);
	const { departmentId } = validateDepartmentAssignment(req.body);
	const user = await userService.assignUserDepartment({
		userId,
		departmentId,
		organizationId: req.auth.organizationId,
		actorId: req.auth.userId,
		access: req.userAccess,
	});
	return res.status(200).json({
		success: true,
		message: departmentId ? 'User department assigned successfully.' : 'User department removed successfully.',
		data: user,
	});
};

export const activateUser = async (req, res) => {
	const userId = validateUserId(req.params.userId);
	const user = await userService.activateUser({
		userId,
		organizationId: req.auth.organizationId,
		actorId: req.auth.userId,
		access: req.userAccess,
	});
	return res.status(200).json({ success: true, message: 'User activated successfully.', data: user });
};

export const deactivateUser = async (req, res) => {
	const userId = validateUserId(req.params.userId);
	const user = await userService.deactivateUser({
		userId,
		organizationId: req.auth.organizationId,
		actorId: req.auth.userId,
		access: req.userAccess,
	});
	return res.status(200).json({ success: true, message: 'User deactivated for this organization.', data: user });
};

export const initiatePasswordReset = async (req, res) => {
	if (Object.keys(req.body || {}).length > 0) {
		throw new AppError('Password reset accepts no request body.', 400, 'VALIDATION_ERROR');
	}
	const userId = validateUserId(req.params.userId);
	await userService.initiateAdminPasswordReset({
		userId,
		organizationId: req.auth.organizationId,
		actorId: req.auth.userId,
		access: req.userAccess,
	});
	return res.status(200).json({
		success: true,
		message: 'Password instructions have been sent to the user.',
	});
};

export default {
	createUser,
	listUsers,
	getUser,
	updateUser,
	assignDepartment,
	activateUser,
	deactivateUser,
	initiatePasswordReset,
};
