import { AppError } from '../../utils/AppError.js';
import * as userService from './user.service.js';
import {
	validateBulkUserIds,
	validateBulkMembershipStatus,
	validateCreateUser,
	validateDepartmentAssignment,
	validateUserId,
	validateUserListQuery,
	validateUpdateUser,
} from './user.validation.js';
import * as bulkUserService from './bulk-user.service.js';

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

export const downloadBulkImportTemplate = async (req, res) => {
	const csv = bulkUserService.getBulkUserImportTemplate();
	return res
		.status(200)
		.type('text/csv')
		.set('Content-Disposition', 'attachment; filename="accessflow-users-template.csv"')
		.send(csv);
};

export const validateBulkImport = async (req, res) => {
	const result = await bulkUserService.validateBulkUserImport({
		organizationId: req.auth.organizationId,
		access: req.userAccess,
		csv: req.bulkUserCsv,
	});
	return res.status(200).json({
		success: true,
		message: 'Bulk import validation completed.',
		data: {
			limits: bulkUserService.bulkImportLimits(),
			summary: result.summary,
			rows: result.rows.map((row) => ({
				rowNumber: row.rowNumber,
				firstName: row.firstName,
				lastName: row.lastName,
				email: row.email,
				department: row.department,
				role: row.role,
				scopeType: row.scopeType || null,
				status: row.status,
				errors: row.errors,
			})),
		},
	});
};

export const confirmBulkImport = async (req, res) => {
	const result = await bulkUserService.confirmBulkUserImport({
		organizationId: req.auth.organizationId,
		actorId: req.auth.userId,
		access: req.userAccess,
		csv: req.bulkUserCsv,
	});
	return res.status(200).json({
		success: true,
		message: 'Bulk import completed.',
		data: result,
	});
};

export const downloadBulkImportFailedReport = async (req, res) => {
	const report = await bulkUserService.getBulkUserFailedReport({
		organizationId: req.auth.organizationId,
		access: req.userAccess,
		csv: req.bulkUserCsv,
	});
	return res
		.status(200)
		.type(report.contentType)
		.set('Content-Disposition', `attachment; filename="${report.filename}"`)
		.send(report.csv);
};

export const bulkDeactivateUsers = async (req, res) => {
	const { userIds } = validateBulkUserIds(req.body);
	const result = await bulkUserService.bulkDeactivateUsers({
		userIds,
		organizationId: req.auth.organizationId,
		actorId: req.auth.userId,
		access: req.userAccess,
	});
	return res.status(200).json({
		success: true,
		message: 'Bulk user deactivation completed.',
		data: result,
	});
};

export const bulkSetMembershipStatus = async (req, res) => {
	const { userIds, status } = validateBulkMembershipStatus(req.body);
	const result = await bulkUserService.bulkSetMembershipStatus({
		userIds,
		status,
		organizationId: req.auth.organizationId,
		actorId: req.auth.userId,
		access: req.userAccess,
	});
	return res.status(200).json({
		success: true,
		message: 'Membership status changes processed.',
		data: result,
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
	downloadBulkImportTemplate,
	validateBulkImport,
	confirmBulkImport,
	downloadBulkImportFailedReport,
	bulkDeactivateUsers,
	bulkSetMembershipStatus,
};
