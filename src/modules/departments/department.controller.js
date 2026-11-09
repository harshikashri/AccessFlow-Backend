import * as departmentService from './department.service.js';
import {
	validateCreateDepartment,
	validateDepartmentId,
	validateDepartmentListQuery,
	validateManagerIds,
	validateMemberIds,
	validateUpdateDepartment,
} from './department.validation.js';

export const createDepartment = async (req, res) => {
	const input = validateCreateDepartment(req.body);
	const department = await departmentService.createDepartment({
		...input,
		organizationId: req.auth.organizationId,
		actorId: req.auth.userId,
		access: req.departmentAccess,
	});
	return res.status(201).json({
		success: true,
		message: 'Department created successfully.',
		data: department,
	});
};

export const listDepartments = async (req, res) => {
	const query = validateDepartmentListQuery(req.query);
	const result = await departmentService.listDepartments({
		...query,
		organizationId: req.auth.organizationId,
		access: req.departmentAccess,
	});
	return res.status(200).json({
		success: true,
		message: 'Departments retrieved successfully.',
		data: result,
	});
};

export const getDepartment = async (req, res) => {
	const departmentId = validateDepartmentId(req.params.departmentId);
	const result = await departmentService.getDepartmentById({
		departmentId,
		organizationId: req.auth.organizationId,
		access: req.departmentAccess,
	});
	return res.status(200).json({
		success: true,
		message: 'Department details retrieved successfully.',
		data: result,
	});
};

export const updateDepartment = async (req, res) => {
	const departmentId = validateDepartmentId(req.params.departmentId);
	const input = validateUpdateDepartment(req.body);
	const department = await departmentService.updateDepartment({
		departmentId,
		organizationId: req.auth.organizationId,
		actorId: req.auth.userId,
		access: req.departmentAccess,
		input,
	});
	return res.status(200).json({
		success: true,
		message: 'Department updated successfully.',
		data: department,
	});
};

export const replaceDepartmentManagers = async (req, res) => {
	const departmentId = validateDepartmentId(req.params.departmentId);
	const managerIds = validateManagerIds(req.body);
	const result = await departmentService.replaceDepartmentManagers({
		departmentId,
		organizationId: req.auth.organizationId,
		actorId: req.auth.userId,
		access: req.departmentAccess,
		managerIds,
	});
	return res.status(200).json({
		success: true,
		message: 'Department managers updated successfully.',
		data: result,
	});
};

export const addDepartmentMembers = async (req, res) => {
	const departmentId = validateDepartmentId(req.params.departmentId);
	const userIds = validateMemberIds(req.body);
	const result = await departmentService.addDepartmentMembers({
		departmentId,
		organizationId: req.auth.organizationId,
		actorId: req.auth.userId,
		access: req.departmentAccess,
		userIds,
	});
	return res.status(200).json({
		success: true,
		message: 'Department members added successfully.',
		data: result,
	});
};

export const removeDepartmentMember = async (req, res) => {
	const departmentId = validateDepartmentId(req.params.departmentId);
	const userId = validateDepartmentId(req.params.userId, 'userId');
	const result = await departmentService.removeDepartmentMember({
		departmentId,
		userId,
		organizationId: req.auth.organizationId,
		actorId: req.auth.userId,
		access: req.departmentAccess,
	});
	return res.status(200).json({
		success: true,
		message: 'Department member removed successfully.',
		data: result,
	});
};

export const activateDepartment = async (req, res) => {
	const departmentId = validateDepartmentId(req.params.departmentId);
	const department = await departmentService.setDepartmentStatus({
		departmentId,
		organizationId: req.auth.organizationId,
		actorId: req.auth.userId,
		access: req.departmentAccess,
		status: 'ACTIVE',
	});
	return res.status(200).json({
		success: true,
		message: 'Department activated successfully.',
		data: department,
	});
};

export const deactivateDepartment = async (req, res) => {
	const departmentId = validateDepartmentId(req.params.departmentId);
	const department = await departmentService.setDepartmentStatus({
		departmentId,
		organizationId: req.auth.organizationId,
		actorId: req.auth.userId,
		access: req.departmentAccess,
		status: 'INACTIVE',
	});
	return res.status(200).json({
		success: true,
		message: 'Department deactivated successfully.',
		data: department,
	});
};

export default {
	createDepartment,
	listDepartments,
	getDepartment,
	updateDepartment,
	replaceDepartmentManagers,
	addDepartmentMembers,
	removeDepartmentMember,
	activateDepartment,
	deactivateDepartment,
};
