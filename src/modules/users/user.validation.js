import mongoose from 'mongoose';
import { ENTITY_STATUS, SCOPE_TYPES } from '../../config/constants.js';
import { AppError } from '../../utils/AppError.js';
import { validatePasswordStrength } from '../../utils/password.js';
import { isValidEmail, normalizeEmail } from '../auth/auth.validation.js';
import {
	USER_EMAIL_MAX,
	USER_NAME_MAX,
	USER_NAME_MIN,
	USER_PAGE_SIZE_DEFAULT,
	USER_PAGE_SIZE_MAX,
	USER_ROLE_ASSIGNMENTS_MAX,
	USER_SEARCH_MAX,
	USER_SORT_FIELDS,
} from './user.constants.js';

const fail = (message) => {
	throw new AppError(message, 400, 'VALIDATION_ERROR');
};

const requireObject = (value, label = 'Request body') => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
};

export const validateUserId = (value, fieldName = 'userId') => {
	if (typeof value !== 'string' || !mongoose.Types.ObjectId.isValid(value)) fail(`Invalid ${fieldName}.`);
	return new mongoose.Types.ObjectId(value).toString();
};

const validateName = (value) => {
	if (typeof value !== 'string') fail('Name is required.');
	const name = value.trim();
	if (name.length < USER_NAME_MIN || name.length > USER_NAME_MAX) {
		fail(`Name must be between ${USER_NAME_MIN} and ${USER_NAME_MAX} characters.`);
	}
	return name;
};

const validateEmail = (value) => {
	const email = normalizeEmail(value);
	if (!email || email.length > USER_EMAIL_MAX || !isValidEmail(email)) fail('A valid email is required.');
	return email;
};

const validateOptionalDepartmentId = (value, fieldName = 'departmentId') => {
	if (value === undefined || value === null || value === '') return null;
	return validateUserId(value, fieldName);
};

const validateRoleAssignments = (value) => {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > USER_ROLE_ASSIGNMENTS_MAX) {
		fail(`roleAssignments must be an array of at most ${USER_ROLE_ASSIGNMENTS_MAX} items.`);
	}

	const assignments = value.map((assignment, index) => {
		requireObject(assignment, `roleAssignments[${index}]`);
		const unknownFields = Object.keys(assignment).filter(
			(field) => !['roleId', 'scopeType', 'departmentId'].includes(field)
		);
		if (unknownFields.length) {
			throw new AppError('Unsupported role assignment fields.', 400, 'VALIDATION_ERROR', unknownFields);
		}

		const roleId = validateUserId(assignment.roleId, `roleAssignments[${index}].roleId`);
		if (!SCOPE_TYPES.includes(assignment.scopeType)) fail('scopeType must be ORGANIZATION or DEPARTMENT.');
		const departmentId = validateOptionalDepartmentId(
			assignment.departmentId,
			`roleAssignments[${index}].departmentId`
		);
		if (assignment.scopeType === 'ORGANIZATION' && departmentId) {
			fail('Organization-scoped role assignments must not include departmentId.');
		}
		if (assignment.scopeType === 'DEPARTMENT' && !departmentId) {
			fail('Department-scoped role assignments require departmentId.');
		}
		return { roleId, scopeType: assignment.scopeType, departmentId };
	});

	const keys = assignments.map((item) => `${item.roleId}:${item.scopeType}:${item.departmentId || ''}`);
	if (new Set(keys).size !== keys.length) fail('Duplicate role assignments are not allowed.');
	return assignments;
};

export const validateCreateUser = (body) => {
	requireObject(body);
	const unknownFields = Object.keys(body).filter(
		(field) => !['name', 'email', 'departmentId', 'roleAssignments'].includes(field)
	);
	if (unknownFields.length) {
		throw new AppError('Unsupported user fields.', 400, 'VALIDATION_ERROR', unknownFields);
	}
	return {
		name: validateName(body.name),
		email: validateEmail(body.email),
		departmentId: validateOptionalDepartmentId(body.departmentId),
		roleAssignments: validateRoleAssignments(body.roleAssignments),
	};
};

export const validateUpdateUser = (body) => {
	requireObject(body);
	const unknownFields = Object.keys(body).filter((field) => !['name', 'email'].includes(field));
	if (unknownFields.length) {
		throw new AppError('Only name and email can be updated.', 400, 'VALIDATION_ERROR', unknownFields);
	}
	if (Object.keys(body).length === 0) fail('At least one user field must be provided.');
	const input = {};
	if (Object.hasOwn(body, 'name')) input.name = validateName(body.name);
	if (Object.hasOwn(body, 'email')) input.email = validateEmail(body.email);
	return input;
};

export const validateDepartmentAssignment = (body) => {
	requireObject(body);
	const unknownFields = Object.keys(body).filter((field) => field !== 'departmentId');
	if (unknownFields.length) {
		throw new AppError('Only departmentId can be updated.', 400, 'VALIDATION_ERROR', unknownFields);
	}
	if (!Object.hasOwn(body, 'departmentId')) fail('departmentId is required; use null to remove the assignment.');
	return { departmentId: validateOptionalDepartmentId(body.departmentId) };
};

export const validateUserListQuery = (query) => {
	requireObject(query, 'Query parameters');
	const allowedFields = ['page', 'limit', 'search', 'status', 'departmentId', 'roleId', 'sortBy', 'sortOrder'];
	const unknownFields = Object.keys(query).filter((field) => !allowedFields.includes(field));
	if (unknownFields.length) {
		throw new AppError('Unknown query parameters are not allowed.', 400, 'VALIDATION_ERROR', unknownFields);
	}

	const parseInteger = (value, name, fallback, max = Number.MAX_SAFE_INTEGER) => {
		if (value === undefined || value === '') return fallback;
		if (typeof value !== 'string' || !/^\d+$/.test(value)) fail(`${name} must be a positive integer.`);
		const number = Number(value);
		if (!Number.isSafeInteger(number) || number < 1 || number > max) {
			fail(`${name} must be between 1 and ${max}.`);
		}
		return number;
	};

	const page = parseInteger(query.page, 'page', 1);
	const limit = parseInteger(query.limit, 'limit', USER_PAGE_SIZE_DEFAULT, USER_PAGE_SIZE_MAX);
	if (query.search !== undefined && typeof query.search !== 'string') fail('search must be a string.');
	const search = query.search?.trim() || '';
	if (search.length > USER_SEARCH_MAX) fail(`search cannot exceed ${USER_SEARCH_MAX} characters.`);

	if (query.status && (typeof query.status !== 'string' || !ENTITY_STATUS.includes(query.status))) {
		fail('status must be ACTIVE or INACTIVE.');
	}
	const departmentId = query.departmentId === 'null'
		? null
		: query.departmentId === undefined || query.departmentId === ''
			? undefined
			: validateUserId(query.departmentId, 'departmentId');
	const roleId = query.roleId ? validateUserId(query.roleId, 'roleId') : undefined;
	const sortBy = query.sortBy || 'createdAt';
	if (typeof sortBy !== 'string' || !USER_SORT_FIELDS.includes(sortBy)) fail('Invalid sortBy field.');
	if (query.sortOrder !== undefined && typeof query.sortOrder !== 'string') fail('sortOrder must be asc or desc.');
	const sortOrder = (query.sortOrder || 'desc').toLowerCase();
	if (!['asc', 'desc'].includes(sortOrder)) fail('sortOrder must be asc or desc.');
	return { page, limit, search, status: query.status || undefined, departmentId, roleId, sortBy, sortOrder };
};

export const validateSetPassword = (body) => {
	requireObject(body);
	const unknownFields = Object.keys(body).filter((field) => !['token', 'password', 'confirmPassword'].includes(field));
	if (unknownFields.length) throw new AppError('Unsupported fields.', 400, 'VALIDATION_ERROR', unknownFields);
	if (typeof body.token !== 'string' || body.token.length < 32 || body.token.length > 256) fail('A valid token is required.');
	if (body.password !== body.confirmPassword) fail('Password and confirmation do not match.');
	validatePasswordStrength(body.password);
	return { token: body.token, password: body.password };
};

export const validatePasswordResetRequest = (body) => {
	requireObject(body);
	const unknownFields = Object.keys(body).filter((field) => field !== 'email');
	if (unknownFields.length) throw new AppError('Only email is allowed.', 400, 'VALIDATION_ERROR', unknownFields);
	return { email: validateEmail(body.email) };
};

export const validateResetPassword = validateSetPassword;

export default {
	validateUserId,
	validateCreateUser,
	validateUpdateUser,
	validateDepartmentAssignment,
	validateUserListQuery,
	validateSetPassword,
	validatePasswordResetRequest,
	validateResetPassword,
};
