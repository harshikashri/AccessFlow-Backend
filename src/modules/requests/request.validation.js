import mongoose from 'mongoose';
import { REQUEST_FIELD_TYPES, REQUEST_PRIORITIES } from '../../config/constants.js';
import { AppError } from '../../utils/AppError.js';
import { validateCondition, validateConditionDependencies } from './request.conditions.js';
import {
  REQUEST_CANCELLATION_REASON_MAX,
  REQUEST_DESCRIPTION_MAX,
  REQUEST_PAGE_SIZE_DEFAULT,
  REQUEST_PAGE_SIZE_MAX,
  REQUEST_DERIVED_FILTERS,
  REQUEST_SORT_FIELDS,
  REQUEST_TITLE_MAX,
  REQUEST_TYPE_CODE_MAX,
  REQUEST_TYPE_DESCRIPTION_MAX,
  REQUEST_TYPE_NAME_MAX,
} from './request.constants.js';

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const fail = (message, details) => { throw new AppError(message, 400, 'VALIDATION_ERROR', details); };
const requireObject = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
};

const validateFieldValidation = (value, type) => {
  if (value === undefined) return {};
  requireObject(value, 'Field validation');
  const allowed = [
    'min', 'max', 'integer', 'integerOnly', 'positiveOnly', 'minLength', 'maxLength',
    'pattern', 'minDate', 'maxDate', 'notPast', 'notInPast', 'notInFuture',
    'gteField', 'requiredWhen', 'minSelections', 'maxSelections',
  ];
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) fail('Unsupported field validation properties.', unknown);
  const result = { ...value };
  for (const key of ['min', 'max', 'minLength', 'maxLength', 'minSelections', 'maxSelections']) {
    if (result[key] !== undefined && (!Number.isFinite(result[key]) || result[key] < 0)) {
      fail(`Field validation ${key} must be a non-negative number.`);
    }
    for (const key of ['minSelections', 'maxSelections']) {
      if (result[key] !== undefined && !Number.isInteger(result[key])) {
        fail(`Field validation ${key} must be an integer.`);
      }
    }
  }
  if (result.min !== undefined && result.max !== undefined && result.min > result.max) {
    fail('Field validation min cannot exceed max.');
  }
  if (result.minLength !== undefined && result.maxLength !== undefined && result.minLength > result.maxLength) {
    fail('Field validation minLength cannot exceed maxLength.');
  }
  if (result.minSelections !== undefined && result.maxSelections !== undefined && result.minSelections > result.maxSelections) {
    fail('Field validation minSelections cannot exceed maxSelections.');
  }
  for (const key of ['integer', 'integerOnly', 'positiveOnly', 'notPast', 'notInPast', 'notInFuture']) {
    if (result[key] !== undefined && typeof result[key] !== 'boolean') fail(`Field validation ${key} must be boolean.`);
  }
  if (result.pattern !== undefined) {
    if (typeof result.pattern !== 'string') fail('Field validation pattern must be a string.');
    try { new RegExp(result.pattern); } catch { fail('Field validation pattern must be a valid regular expression.'); }
  }
  if (type !== 'NUMBER' && (result.min !== undefined || result.max !== undefined ||
      result.integer !== undefined || result.integerOnly !== undefined || result.positiveOnly !== undefined)) {
    fail('Numeric validation is only supported for NUMBER fields.');
  }
  if (!['TEXT', 'TEXTAREA'].includes(type) && (result.minLength !== undefined ||
      result.maxLength !== undefined || result.pattern !== undefined)) {
    fail('Text validation is only supported for TEXT or TEXTAREA fields.');
  }
  if (type !== 'DATE' && (result.minDate !== undefined || result.maxDate !== undefined ||
      result.notPast !== undefined || result.notInPast !== undefined || result.notInFuture !== undefined ||
      result.gteField !== undefined)) {
    fail('Date validation is only supported for DATE fields.');
  }
  if (type !== 'MULTI_SELECT' && (result.minSelections !== undefined || result.maxSelections !== undefined)) {
    fail('Selection count validation is only supported for MULTI_SELECT fields.');
  }
  if (result.minDate !== undefined && Number.isNaN(Date.parse(result.minDate))) fail('Field validation minDate must be a valid date.');
  if (result.maxDate !== undefined && Number.isNaN(Date.parse(result.maxDate))) fail('Field validation maxDate must be a valid date.');
  if (result.minDate !== undefined && result.maxDate !== undefined && new Date(result.minDate) > new Date(result.maxDate)) {
    fail('Field validation minDate cannot exceed maxDate.');
  }
  if (result.requiredWhen !== undefined) {
    requireObject(result.requiredWhen, 'Field validation requiredWhen');
    if (typeof result.requiredWhen.field !== 'string' || result.requiredWhen.equals === undefined) {
      fail('Field validation requiredWhen must define field and equals.');
    }
  }
  if (result.gteField !== undefined && typeof result.gteField !== 'string') fail('Field validation gteField must be a string.');
  return result;
};
const validateId = (value, name) => {
  if (typeof value !== 'string' || !mongoose.Types.ObjectId.isValid(value)) fail(`Invalid ${name}.`);
  return new mongoose.Types.ObjectId(value).toString();
};
const stringValue = (value, name, min = 0, max = 2000) => {
  if (typeof value !== 'string') fail(`${name} must be a string.`);
  const result = value.trim();
  if (result.length < min || result.length > max) fail(`${name} must be between ${min} and ${max} characters.`);
  return result;
};

const validateField = (field) => {
  requireObject(field, 'Each field');
  const allowed = ['key', 'label', 'description', 'type', 'semantic', 'required', 'placeholder', 'options', 'validation', 'visibleWhen', 'requiredWhen', 'displayOrder'];
  const unknown = Object.keys(field).filter((key) => !allowed.includes(key));
  if (unknown.length) fail('Unsupported request type field properties.', unknown);
  const key = stringValue(field.key, 'Field key', 1, 100);
  if (RESERVED_KEYS.has(key)) fail('Reserved field keys are not allowed.');
  const result = {
    key,
    label: stringValue(field.label, 'Field label', 1, 200),
    description: field.description === undefined ? '' : stringValue(field.description, 'Field description', 0, 1000),
    type: field.type,
    semantic: field.semantic === undefined ? null : field.semantic,
    required: field.required === true,
    placeholder: field.placeholder === undefined ? '' : stringValue(field.placeholder, 'Field placeholder', 0, 500),
    displayOrder: field.displayOrder === undefined ? 0 : field.displayOrder,
    validation: validateFieldValidation(field.validation, field.type),
    visibleWhen: field.visibleWhen === undefined ? null : field.visibleWhen,
    requiredWhen: field.requiredWhen === undefined ? null : field.requiredWhen,
  };
  if (!REQUEST_FIELD_TYPES.includes(field.type)) fail('Unsupported request field type.');
  if (result.semantic !== null && result.semantic !== 'AMOUNT') fail('Unsupported request field semantic.');
  if (result.semantic === 'AMOUNT' && (field.type !== 'NUMBER' || field.required !== true)) {
    fail('Amount fields must be required NUMBER fields.');
  }
  if (!Number.isInteger(result.displayOrder) || result.displayOrder < 0) fail('Field displayOrder must be a non-negative integer.');
  if (field.required !== undefined && typeof field.required !== 'boolean') fail('Field required must be boolean.');
  if (field.type === 'SELECT' || field.type === 'MULTI_SELECT') {
    if (!Array.isArray(field.options) || field.options.length === 0) fail('Select fields require options.');
    const options = field.options.map((option) => typeof option === 'string' ? option.trim() : option);
    if (options.some((option) => !option) || new Set(options).size !== options.length) fail('Field options must be unique, non-empty strings.');
    result.options = options;
    if (field.type === 'MULTI_SELECT') {
      const { minSelections, maxSelections } = result.validation;
      if (minSelections !== undefined && minSelections > options.length) fail('Field minSelections cannot exceed option count.');
      if (maxSelections !== undefined && maxSelections > options.length) fail('Field maxSelections cannot exceed option count.');
    }
  } else if (field.options !== undefined) {
    fail('Options are only supported for SELECT and MULTI_SELECT fields.');
  }
  return result;
};

export const validateRequestType = (body) => {
  requireObject(body, 'Request type body');
  const allowed = ['name', 'code', 'description', 'fields'];
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) fail('Unsupported request type fields.', unknown);
  if (body.name === undefined || body.code === undefined || !Array.isArray(body.fields)) fail('name, code and fields are required.');
  const fields = body.fields.map(validateField);
  const keys = fields.map((field) => field.key);
  if (new Set(keys).size !== keys.length) fail('Request type field keys must be unique.');
  if (fields.filter((field) => field.semantic === 'AMOUNT').length > 1) {
    fail('A request type can define only one amount field.');
  }
  for (const field of fields) {
    if (field.visibleWhen) validateCondition(field.visibleWhen, fields, field.key);
    if (field.requiredWhen) validateCondition(field.requiredWhen, fields, field.key);
    if (field.validation.requiredWhen) validateCondition(field.validation.requiredWhen, fields, field.key);
  }
  validateConditionDependencies(fields);
  return {
    name: stringValue(body.name, 'Request type name', 2, REQUEST_TYPE_NAME_MAX),
    code: stringValue(body.code, 'Request type code', 1, REQUEST_TYPE_CODE_MAX),
    description: body.description === undefined ? '' : stringValue(body.description, 'Request type description', 0, REQUEST_TYPE_DESCRIPTION_MAX),
    fields,
  };
};

export const validateRequestTypeUpdate = validateRequestType;

const validateDetails = (value) => {
  requireObject(value, 'details');
  if (Object.keys(value).some((key) => RESERVED_KEYS.has(key))) fail('Reserved detail keys are not allowed.');
  return value;
};

const validateAttachments = (value) => {
  if (!Array.isArray(value)) fail('attachments must be an array.');
  return value.map((attachment) => {
    requireObject(attachment, 'Each attachment');
    const allowed = ['filename', 'mimeType', 'size', 'storageKey', 'checksum'];
    const unknown = Object.keys(attachment).filter((key) => !allowed.includes(key));
    if (unknown.length) fail('Unsupported attachment fields.', unknown);
    if (!Number.isSafeInteger(attachment.size) || attachment.size < 0) fail('Attachment size must be a non-negative integer.');
    return {
      filename: stringValue(attachment.filename, 'Attachment filename', 1, 255),
      mimeType: stringValue(attachment.mimeType, 'Attachment mimeType', 1, 100),
      size: attachment.size,
      storageKey: stringValue(attachment.storageKey, 'Attachment storageKey', 1, 500),
      checksum: attachment.checksum === undefined ? null : stringValue(attachment.checksum, 'Attachment checksum', 0, 200),
    };
  });
};

export const validateCreateRequest = (body) => {
  requireObject(body, 'Request body');
  const allowed = ['departmentId', 'requestTypeId', 'title', 'description', 'priority', 'details', 'attachments'];
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) fail('Unsupported request fields.', unknown);
  return {
    departmentId: validateId(body.departmentId, 'departmentId'),
    requestTypeId: validateId(body.requestTypeId, 'requestTypeId'),
    title: stringValue(body.title, 'title', 3, REQUEST_TITLE_MAX),
    description: body.description === undefined ? '' : stringValue(body.description, 'description', 0, REQUEST_DESCRIPTION_MAX),
    priority: body.priority === undefined ? 'MEDIUM' : body.priority,
    details: validateDetails(body.details || {}),
    attachments: body.attachments === undefined ? [] : validateAttachments(body.attachments),
  };
};

export const validateUpdateRequest = (body) => {
  requireObject(body, 'Request body');
  const allowed = ['departmentId', 'title', 'description', 'priority', 'details', 'attachments'];
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) fail('Unsupported request fields.', unknown);
  if (!Object.keys(body).length) fail('At least one request field must be provided.');
  const result = {};
  if (body.departmentId !== undefined) result.departmentId = validateId(body.departmentId, 'departmentId');
  if (body.title !== undefined) result.title = stringValue(body.title, 'title', 3, REQUEST_TITLE_MAX);
  if (body.description !== undefined) result.description = stringValue(body.description, 'description', 0, REQUEST_DESCRIPTION_MAX);
  if (body.priority !== undefined) result.priority = body.priority;
  if (body.details !== undefined) result.details = validateDetails(body.details);
  if (body.attachments !== undefined) result.attachments = validateAttachments(body.attachments);
  return result;
};

export const validateCancellation = (body) => {
  requireObject(body, 'Cancellation body');
  const unknown = Object.keys(body).filter((key) => key !== 'cancellationReason');
  if (unknown.length) fail('Unsupported cancellation fields.', unknown);
  return { cancellationReason: stringValue(body.cancellationReason, 'cancellationReason', 1, REQUEST_CANCELLATION_REASON_MAX) };
};

export const validateRequestTypeId = (value) => validateId(value, 'requestTypeId');
export const validateRequestId = (value) => validateId(value, 'requestId');

export const validateRequestListQuery = (query) => {
  requireObject(query, 'Query parameters');
  const allowed = [
    'page', 'limit', 'search', 'status', 'requestTypeId', 'departmentId', 'requesterId',
    'priority', 'approvalStage', 'derivedFilter', 'from', 'to', 'fromDate', 'toDate',
    'sortBy', 'sortOrder',
  ];
  const unknown = Object.keys(query).filter((key) => !allowed.includes(key));
  if (unknown.length) fail('Unknown query parameters are not allowed.', unknown);
  const parseInteger = (value, fallback, max) => {
    if (value === undefined || value === '') return fallback;
    if (typeof value !== 'string' || !/^\d+$/.test(value)) fail('Pagination values must be positive integers.');
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) fail('Pagination value is out of range.');
    return parsed;
  };
  const page = parseInteger(query.page, 1, Number.MAX_SAFE_INTEGER);
  const limit = parseInteger(query.limit, REQUEST_PAGE_SIZE_DEFAULT, REQUEST_PAGE_SIZE_MAX);
  if (query.status !== undefined && !['ALL', 'DRAFT', 'SUBMITTED', 'PENDING_APPROVAL', 'RETURNED', 'APPROVED', 'REJECTED', 'CANCELLED'].includes(query.status)) fail('Invalid request status.');
  if (query.priority !== undefined && !REQUEST_PRIORITIES.includes(query.priority)) fail('Invalid request priority.');
  const requestTypeId = query.requestTypeId ? validateId(query.requestTypeId, 'requestTypeId') : undefined;
  const departmentId = query.departmentId ? validateId(query.departmentId, 'departmentId') : undefined;
  const requesterId = query.requesterId ? validateId(query.requesterId, 'requesterId') : undefined;
  const approvalStage = query.approvalStage === undefined ? undefined : stringValue(query.approvalStage, 'approvalStage', 1, 100);
  const derivedFilter = query.derivedFilter;
  if (derivedFilter !== undefined && !REQUEST_DERIVED_FILTERS.includes(derivedFilter)) fail('Invalid derivedFilter.');
  const sortBy = query.sortBy || 'createdAt';
  if (!REQUEST_SORT_FIELDS.includes(sortBy)) fail('Invalid sortBy field.');
  const sortOrder = (query.sortOrder || 'desc').toLowerCase();
  if (!['asc', 'desc'].includes(sortOrder)) fail('sortOrder must be asc or desc.');
  const from = query.fromDate || query.from;
  const to = query.toDate || query.to;
  if (query.fromDate && query.from && query.fromDate !== query.from) fail('Use either fromDate or from, not conflicting values.');
  if (query.toDate && query.to && query.toDate !== query.to) fail('Use either toDate or to, not conflicting values.');
  for (const [name, value] of [['fromDate', from], ['toDate', to]]) {
    if (value !== undefined && (typeof value !== 'string' || Number.isNaN(Date.parse(value)))) {
      fail(`${name} must be a valid date.`);
    }
  }
  if (from && to && new Date(from) > new Date(to)) fail('fromDate must be before toDate.');
  const search = query.search === undefined ? '' : stringValue(query.search, 'search', 0, 200);
  return {
    page, limit, search, status: query.status === 'ALL' ? undefined : query.status,
    requestTypeId, departmentId, requesterId, priority: query.priority, approvalStage, derivedFilter,
    from, to, sortBy, sortOrder,
  };
};

export const validateRequestSearchQuery = (query) => {
  requireObject(query, 'Query parameters');
  const allowed = ['category', 'departmentId', 'userId', 'status', 'page', 'limit', 'sortBy', 'sortOrder', 'search'];
  const unknown = Object.keys(query).filter((key) => !allowed.includes(key));
  if (unknown.length) fail('Unknown query parameters are not allowed.', unknown);
  const parseInteger = (value, fallback, max) => {
    if (value === undefined || value === '') return fallback;
    if (typeof value !== 'string' || !/^\d+$/.test(value)) fail('Pagination values must be positive integers.');
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) fail('Pagination value is out of range.');
    return parsed;
  };
  const page = parseInteger(query.page, 1, Number.MAX_SAFE_INTEGER);
  const limit = parseInteger(query.limit, REQUEST_PAGE_SIZE_DEFAULT, REQUEST_PAGE_SIZE_MAX);
  if (query.status !== undefined && !['ALL', 'DRAFT', 'SUBMITTED', 'PENDING_APPROVAL', 'RETURNED', 'APPROVED', 'REJECTED', 'CANCELLED'].includes(query.status)) fail('Invalid request status.');
  const category = query.category ? validateId(query.category, 'category') : undefined;
  const departmentId = query.departmentId ? validateId(query.departmentId, 'departmentId') : undefined;
  const userId = query.userId ? validateId(query.userId, 'userId') : undefined;
  const sortBy = query.sortBy || 'createdAt';
  if (!REQUEST_SORT_FIELDS.includes(sortBy)) fail('Invalid sortBy field.');
  const sortOrder = (query.sortOrder || 'desc').toLowerCase();
  if (!['asc', 'desc'].includes(sortOrder)) fail('sortOrder must be asc or desc.');
  const search = query.search === undefined ? '' : stringValue(query.search, 'search', 0, 200);
  return { page, limit, requestTypeId: category, departmentId, userId, status: query.status === 'ALL' ? undefined : query.status, sortBy, sortOrder, search };
};