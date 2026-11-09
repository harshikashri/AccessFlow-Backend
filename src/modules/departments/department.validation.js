import mongoose from 'mongoose';
import { AppError } from '../../utils/AppError.js';
import { ENTITY_STATUS } from '../../config/constants.js';
import {
	DEPARTMENT_ASSIGNMENT_MAX,
	DEPARTMENT_DESCRIPTION_MAX,
	DEPARTMENT_NAME_MAX,
	DEPARTMENT_NAME_MIN,
	DEPARTMENT_PAGE_SIZE_DEFAULT,
	DEPARTMENT_PAGE_SIZE_MAX,
	DEPARTMENT_SORT_FIELDS,
} from './department.constants.js';

const fail = (message) => {
	throw new AppError(message, 400, 'VALIDATION_ERROR');
};

const requireObject = (value, label) => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		fail(`${label} must be an object.`);
	}
};

export const validateDepartmentId = (value, fieldName = 'departmentId') => {
	if (typeof value !== 'string' || !mongoose.Types.ObjectId.isValid(value)) {
		fail(`Invalid ${fieldName}.`);
	}
	return value;
};

const validateName = (value) => {
	if (typeof value !== 'string') {
		fail('Department name is required.');
	}
	const name = value.trim();
	if (name.length < DEPARTMENT_NAME_MIN || name.length > DEPARTMENT_NAME_MAX) {
		fail(`Department name must be between ${DEPARTMENT_NAME_MIN} and ${DEPARTMENT_NAME_MAX} characters.`);
	}
	return name;
};

const validateDescription = (value) => {
	if (typeof value !== 'string') {
		fail('Department description must be a string.');
	}
	const description = value.trim();
	if (description.length > DEPARTMENT_DESCRIPTION_MAX) {
		fail(`Department description cannot exceed ${DEPARTMENT_DESCRIPTION_MAX} characters.`);
	}
	return description;
};

const validateIdArray = (value, fieldName, { allowEmpty = false } = {}) => {
	if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
		fail(`${fieldName} must be a${allowEmpty ? '' : ' non-empty'} array.`);
	}
	if (value.length > DEPARTMENT_ASSIGNMENT_MAX) {
		fail(`${fieldName} cannot contain more than ${DEPARTMENT_ASSIGNMENT_MAX} IDs.`);
	}

	const normalizedIds = value.map((id) => {
		validateDepartmentId(id, `${fieldName} item`);
		return new mongoose.Types.ObjectId(id).toString();
	});
	if (new Set(normalizedIds).size !== normalizedIds.length) {
		fail(`${fieldName} cannot contain duplicate IDs.`);
	}
	return normalizedIds;
};

export const validateCreateDepartment = (body) => {
	requireObject(body, 'Request body');
	const unknownFields = Object.keys(body).filter((key) => !['name', 'description'].includes(key));
	if (unknownFields.length) {
		throw new AppError('Only name and description are allowed.', 400, 'VALIDATION_ERROR', unknownFields);
	}

	return {
		name: validateName(body.name),
		description: body.description === undefined ? '' : validateDescription(body.description),
	};
};

export const validateUpdateDepartment = (body) => {
	requireObject(body, 'Request body');
	const unknownFields = Object.keys(body).filter((key) => !['name', 'description'].includes(key));
	if (unknownFields.length) {
		throw new AppError('Only name and description can be updated.', 400, 'VALIDATION_ERROR', unknownFields);
	}
	if (Object.keys(body).length === 0) {
		fail('At least one department field must be provided.');
	}

	const input = {};
	if (Object.hasOwn(body, 'name')) {
		input.name = validateName(body.name);
	}
	if (Object.hasOwn(body, 'description')) {
		input.description = validateDescription(body.description);
	}
	return input;
};

export const validateManagerIds = (body) => {
	requireObject(body, 'Request body');
	const unknownFields = Object.keys(body).filter((key) => key !== 'managerIds');
	if (unknownFields.length) {
		throw new AppError('Only managerIds are allowed.', 400, 'VALIDATION_ERROR', unknownFields);
	}
	return validateIdArray(body.managerIds, 'managerIds', { allowEmpty: true });
};

export const validateMemberIds = (body) => {
	requireObject(body, 'Request body');
	const unknownFields = Object.keys(body).filter((key) => key !== 'userIds');
	if (unknownFields.length) {
		throw new AppError('Only userIds are allowed.', 400, 'VALIDATION_ERROR', unknownFields);
	}
	return validateIdArray(body.userIds, 'userIds');
};

export const validateDepartmentListQuery = (query) => {
	requireObject(query, 'Query parameters');
	const allowedFields = ['page', 'limit', 'search', 'status', 'sortBy', 'sortOrder'];
	const unknownFields = Object.keys(query).filter((key) => !allowedFields.includes(key));
	if (unknownFields.length) {
		throw new AppError('Unknown query parameters are not allowed.', 400, 'VALIDATION_ERROR', unknownFields);
	}

	const parsePositiveInteger = (value, name, defaultValue, maximum = Number.MAX_SAFE_INTEGER) => {
		if (value === undefined || value === '') return defaultValue;
		if (typeof value !== 'string' || !/^\d+$/.test(value)) {
			fail(`${name} must be a positive integer.`);
		}
		const parsed = Number(value);
		if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
			fail(`${name} must be between 1 and ${maximum}.`);
		}
		return parsed;
	};

	const page = parsePositiveInteger(query.page, 'page', 1);
	const limit = parsePositiveInteger(
		query.limit,
		'limit',
		DEPARTMENT_PAGE_SIZE_DEFAULT,
		DEPARTMENT_PAGE_SIZE_MAX
	);

	if (query.search !== undefined && typeof query.search !== 'string') {
		fail('search must be a string.');
	}
	const search = query.search?.trim() || '';

	if (
		query.status !== undefined &&
		query.status !== '' &&
		(typeof query.status !== 'string' || !ENTITY_STATUS.includes(query.status))
	) {
		fail('status must be ACTIVE or INACTIVE.');
	}
	const status = query.status || undefined;

	const sortBy = query.sortBy || 'createdAt';
	if (typeof sortBy !== 'string' || !DEPARTMENT_SORT_FIELDS.includes(sortBy)) {
		fail('Invalid sortBy field.');
	}
	if (query.sortOrder !== undefined && typeof query.sortOrder !== 'string') {
		fail('sortOrder must be asc or desc.');
	}
	const sortOrder = (query.sortOrder || 'desc').toLowerCase();
	if (!['asc', 'desc'].includes(sortOrder)) {
		fail('sortOrder must be asc or desc.');
	}

	return { page, limit, search, status, sortBy, sortOrder };
};

export default {
	validateDepartmentId,
	validateCreateDepartment,
	validateUpdateDepartment,
	validateManagerIds,
	validateMemberIds,
	validateDepartmentListQuery,
};
