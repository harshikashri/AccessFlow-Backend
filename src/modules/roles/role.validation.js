import mongoose from 'mongoose';
import { ENTITY_STATUS, PERMISSION_CATALOG, SCOPE_TYPES } from '../../config/constants.js';
import { AppError } from '../../utils/AppError.js';
import {
	CREATABLE_ROLE_TYPES,
	ROLE_DESCRIPTION_MAX,
	ROLE_NAME_MAX,
	ROLE_NAME_MIN,
	ROLE_PAGE_SIZE_DEFAULT,
	ROLE_PAGE_SIZE_MAX,
	ROLE_SORT_FIELDS,
} from './role.constants.js';

const fail = (message) => {
	throw new AppError(message, 400, 'VALIDATION_ERROR');
};

const requireObject = (value, label = 'Request body') => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
};

export const validateRoleId = (value, fieldName = 'roleId') => {
	if (typeof value !== 'string' || !mongoose.Types.ObjectId.isValid(value)) fail(`Invalid ${fieldName}.`);
	return new mongoose.Types.ObjectId(value).toString();
};

const validateName = (value) => {
	if (typeof value !== 'string') fail('Role name is required.');
	const name = value.trim();
	if (name.length < ROLE_NAME_MIN || name.length > ROLE_NAME_MAX) {
		fail(`Role name must be between ${ROLE_NAME_MIN} and ${ROLE_NAME_MAX} characters.`);
	}
	return name;
};

const validateDescription = (value) => {
	if (typeof value !== 'string') fail('Role description must be a string.');
	const description = value.trim();
	if (description.length > ROLE_DESCRIPTION_MAX) fail(`Role description cannot exceed ${ROLE_DESCRIPTION_MAX} characters.`);
	return description;
};

export const validatePermissions = (value) => {
	if (!Array.isArray(value)) fail('permissions must be an array.');
	const unknown = value.filter((permission) => typeof permission !== 'string' || !PERMISSION_CATALOG.includes(permission));
	if (unknown.length) {
		throw new AppError('One or more permissions are not in the permission catalog.', 400, 'INVALID_PERMISSIONS', {
			permissions: unknown,
		});
	}
	if (new Set(value).size !== value.length) fail('permissions cannot contain duplicates.');
	return [...value];
};

export const validateCreateRole = (body) => {
	requireObject(body);
	const unknown = Object.keys(body).filter((key) => !['name', 'description', 'permissions', 'roleType'].includes(key));
	if (unknown.length) throw new AppError('Unsupported role fields.', 400, 'VALIDATION_ERROR', unknown);
	const roleType = body.roleType === undefined ? 'CUSTOM' : body.roleType;
	if (!CREATABLE_ROLE_TYPES.includes(roleType)) fail('Built-in roles are provisioned with the organization and cannot be created through this API.');
	return {
		name: validateName(body.name),
		description: body.description === undefined ? '' : validateDescription(body.description),
		permissions: validatePermissions(body.permissions),
		roleType,
	};
};

export const validateUpdateRole = (body) => {
	requireObject(body);
	const unknown = Object.keys(body).filter((key) => !['name', 'description'].includes(key));
	if (unknown.length) throw new AppError('Only role name and description can be updated here.', 400, 'VALIDATION_ERROR', unknown);
	if (Object.keys(body).length === 0) fail('At least one role field must be provided.');
	const input = {};
	if (Object.hasOwn(body, 'name')) input.name = validateName(body.name);
	if (Object.hasOwn(body, 'description')) input.description = validateDescription(body.description);
	return input;
};

export const validatePermissionUpdate = (body) => {
	requireObject(body);
	const unknown = Object.keys(body).filter((key) => key !== 'permissions');
	if (unknown.length) throw new AppError('Only permissions can be updated.', 400, 'VALIDATION_ERROR', unknown);
	return { permissions: validatePermissions(body.permissions) };
};

export const validateRoleListQuery = (query) => {
	requireObject(query, 'Query parameters');
	const allowed = ['page', 'limit', 'search', 'status', 'sortBy', 'sortOrder'];
	const unknown = Object.keys(query).filter((key) => !allowed.includes(key));
	if (unknown.length) throw new AppError('Unknown query parameters are not allowed.', 400, 'VALIDATION_ERROR', unknown);
	const parseInteger = (value, name, fallback, max = Number.MAX_SAFE_INTEGER) => {
		if (value === undefined || value === '') return fallback;
		if (typeof value !== 'string' || !/^\d+$/.test(value)) fail(`${name} must be a positive integer.`);
		const number = Number(value);
		if (!Number.isSafeInteger(number) || number < 1 || number > max) fail(`${name} is out of range.`);
		return number;
	};
	const page = parseInteger(query.page, 'page', 1);
	const limit = parseInteger(query.limit, 'limit', ROLE_PAGE_SIZE_DEFAULT, ROLE_PAGE_SIZE_MAX);
	if (query.search !== undefined && typeof query.search !== 'string') fail('search must be a string.');
	const search = query.search?.trim() || '';
	if (query.status && (typeof query.status !== 'string' || !ENTITY_STATUS.includes(query.status))) {
		fail('status must be ACTIVE or INACTIVE.');
	}
	const sortBy = query.sortBy || 'createdAt';
	if (typeof sortBy !== 'string' || !ROLE_SORT_FIELDS.includes(sortBy)) fail('Invalid sortBy field.');
	if (query.sortOrder !== undefined && typeof query.sortOrder !== 'string') fail('sortOrder must be asc or desc.');
	const sortOrder = (query.sortOrder || 'desc').toLowerCase();
	if (!['asc', 'desc'].includes(sortOrder)) fail('sortOrder must be asc or desc.');
	return { page, limit, search, status: query.status || undefined, sortBy, sortOrder };
};

export const validateRoleAssignment = (body) => {
	requireObject(body);
	const unknown = Object.keys(body).filter((key) => !['userId', 'scopeType', 'departmentId'].includes(key));
	if (unknown.length) throw new AppError('Unsupported assignment fields.', 400, 'VALIDATION_ERROR', unknown);
	const userId = validateRoleId(body.userId, 'userId');
	if (!SCOPE_TYPES.includes(body.scopeType)) fail('scopeType must be ORGANIZATION or DEPARTMENT.');
	let departmentId = null;
	if (body.departmentId !== undefined && body.departmentId !== null && body.departmentId !== '') {
		departmentId = validateRoleId(body.departmentId, 'departmentId');
	}
	if (body.scopeType === 'ORGANIZATION' && departmentId) fail('Organization-scoped assignments must not include departmentId.');
	if (body.scopeType === 'DEPARTMENT' && !departmentId) fail('Department-scoped assignments require departmentId.');
	return { userId, scopeType: body.scopeType, departmentId };
};

export const validateAssignmentScope = (body) => {
	requireObject(body);
	const unknown = Object.keys(body).filter((key) => !['scopeType', 'departmentId'].includes(key));
	if (unknown.length) throw new AppError('Scope is required to identify the assignment.', 400, 'VALIDATION_ERROR', unknown);
	if (!SCOPE_TYPES.includes(body.scopeType)) fail('scopeType must be ORGANIZATION or DEPARTMENT.');
	let departmentId = null;
	if (body.departmentId !== undefined && body.departmentId !== null && body.departmentId !== '') {
		departmentId = validateRoleId(body.departmentId, 'departmentId');
	}
	if (body.scopeType === 'ORGANIZATION' && departmentId) fail('Organization-scoped assignments must not include departmentId.');
	if (body.scopeType === 'DEPARTMENT' && !departmentId) fail('Department-scoped assignments require departmentId.');
	return { scopeType: body.scopeType, departmentId };
};

export const validatePaginationQuery = (query) => {
	requireObject(query, 'Query parameters');
	const allowed = ['page', 'limit'];
	const unknown = Object.keys(query).filter((key) => !allowed.includes(key));
	if (unknown.length) throw new AppError('Unknown query parameters are not allowed.', 400, 'VALIDATION_ERROR', unknown);
	const page = query.page === undefined ? 1 : Number(query.page);
	const limit = query.limit === undefined ? ROLE_PAGE_SIZE_DEFAULT : Number(query.limit);
	if (!Number.isSafeInteger(page) || page < 1) fail('page must be a positive integer.');
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > ROLE_PAGE_SIZE_MAX) fail(`limit must be between 1 and ${ROLE_PAGE_SIZE_MAX}.`);
	return { page, limit };
};

export default {
	validateRoleId,
	validatePermissions,
	validateCreateRole,
	validateUpdateRole,
	validatePermissionUpdate,
	validateRoleListQuery,
	validateRoleAssignment,
	validateAssignmentScope,
	validatePaginationQuery,
};
