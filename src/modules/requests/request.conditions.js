import { AppError } from '../../utils/AppError.js';

const OPERATORS = new Set([
  'EQUALS', 'NOT_EQUALS', 'GREATER_THAN', 'GREATER_THAN_OR_EQUAL',
  'LESS_THAN', 'LESS_THAN_OR_EQUAL', 'CONTAINS', 'NOT_CONTAINS',
  'IN', 'NOT_IN', 'IS_EMPTY', 'IS_NOT_EMPTY', 'IS_TRUE', 'IS_FALSE',
]);
const GROUPS = new Set(['AND', 'OR']);
const MAX_CONDITIONS = 10;
const MAX_DEPTH = 3;

const normalizeCondition = (condition) => {
  if (!condition || condition.operator || condition.conditions) return condition;
  if (Object.prototype.hasOwnProperty.call(condition, 'equals')) {
    return { ...condition, operator: 'EQUALS', value: condition.equals };
  }
  return condition;
};

const referencedFields = (condition, result = new Set()) => {
  const normalized = normalizeCondition(condition);
  if (!normalized || typeof normalized !== 'object') return result;
  if (GROUPS.has(normalized.operator)) {
    normalized.conditions?.forEach((item) => referencedFields(item, result));
  } else if (typeof normalized.field === 'string') {
    result.add(normalized.field);
  }
  return result;
};

const empty = (value) => value === undefined || value === null || value === '' ||
  (Array.isArray(value) && value.length === 0);

const compare = (actual, operator, expected) => {
  if (operator === 'IS_EMPTY') return empty(actual);
  if (operator === 'IS_NOT_EMPTY') return !empty(actual);
  if (operator === 'IS_TRUE') return actual === true;
  if (operator === 'IS_FALSE') return actual === false;
  if (operator === 'EQUALS') return actual === expected;
  if (operator === 'NOT_EQUALS') return actual !== expected;
  if (operator === 'CONTAINS' || operator === 'NOT_CONTAINS') {
    const result = Array.isArray(actual)
      ? actual.includes(expected)
      : typeof actual === 'string' && actual.includes(expected);
    return operator === 'CONTAINS' ? result : !result;
  }
  if (operator === 'IN' || operator === 'NOT_IN') {
    const result = Array.isArray(expected) && expected.includes(actual);
    return operator === 'IN' ? result : !result;
  }
  if (operator === 'GREATER_THAN') return actual > expected;
  if (operator === 'GREATER_THAN_OR_EQUAL') return actual >= expected;
  if (operator === 'LESS_THAN') return actual < expected;
  if (operator === 'LESS_THAN_OR_EQUAL') return actual <= expected;
  return false;
};

const compatible = (field, operator, value) => {
  const numeric = ['NUMBER'];
  const text = ['TEXT', 'TEXTAREA'];
  const selection = ['SELECT', 'MULTI_SELECT'];
  if (['GREATER_THAN', 'GREATER_THAN_OR_EQUAL', 'LESS_THAN', 'LESS_THAN_OR_EQUAL'].includes(operator) &&
      !numeric.includes(field.type) && field.type !== 'DATE') return false;
  if (['CONTAINS', 'NOT_CONTAINS'].includes(operator) && !text.includes(field.type) && field.type !== 'MULTI_SELECT') return false;
  if (['IN', 'NOT_IN'].includes(operator) && !selection.includes(field.type)) return false;
  if (['IS_TRUE', 'IS_FALSE'].includes(operator) && field.type !== 'CHECKBOX') return false;
  if (numeric.includes(field.type) && ['GREATER_THAN', 'GREATER_THAN_OR_EQUAL', 'LESS_THAN', 'LESS_THAN_OR_EQUAL'].includes(operator) &&
      (typeof value !== 'number' || !Number.isFinite(value))) return false;
  if (selection.includes(field.type) && ['IN', 'NOT_IN'].includes(operator) &&
      (!Array.isArray(value) || value.length === 0)) return false;
  return true;
};

export const validateCondition = (condition, fields, controlledKey, depth = 0) => {
  condition = normalizeCondition(condition);
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
    throw new AppError('Conditional rules must be objects.', 400, 'VALIDATION_ERROR');
  }
  if (depth > MAX_DEPTH) throw new AppError('Conditional rule nesting is too deep.', 400, 'VALIDATION_ERROR');
  if (condition.operator && GROUPS.has(condition.operator)) {
    if (!Array.isArray(condition.conditions) || condition.conditions.length < 1 || condition.conditions.length > MAX_CONDITIONS) {
      throw new AppError('Conditional groups must contain between 1 and 10 conditions.', 400, 'VALIDATION_ERROR');
    }
    condition.conditions.forEach((item) => validateCondition(item, fields, controlledKey, depth + 1));
    return;
  }
  if (typeof condition.field !== 'string' || condition.field === controlledKey) {
    throw new AppError('Conditional rules must reference another field.', 400, 'VALIDATION_ERROR');
  }
  const source = fields.find((field) => field.key === condition.field);
  if (!source || !OPERATORS.has(condition.operator)) {
    throw new AppError('Conditional rule references an invalid field or operator.', 400, 'VALIDATION_ERROR');
  }
  if (!compatible(source, condition.operator, condition.value)) {
    throw new AppError('Conditional operator is incompatible with the referenced field.', 400, 'VALIDATION_ERROR');
  }
  if (!['IS_EMPTY', 'IS_NOT_EMPTY', 'IS_TRUE', 'IS_FALSE'].includes(condition.operator) &&
      condition.value === undefined) {
    throw new AppError('Conditional rules require a comparison value.', 400, 'VALIDATION_ERROR');
  }
};

export const evaluateCondition = (condition, details, depth = 0) => {
  condition = normalizeCondition(condition);
  if (!condition) return true;
  if (depth > MAX_DEPTH) return false;
  if (GROUPS.has(condition.operator)) {
    const results = condition.conditions.map((item) => evaluateCondition(item, details, depth + 1));
    return condition.operator === 'AND' ? results.every(Boolean) : results.some(Boolean);
  }
  return compare(details?.[condition.field], condition.operator, condition.value);
};

export const validateConditionDependencies = (fields) => {
  const graph = new Map(fields.map((field) => [field.key, new Set()]));
  for (const field of fields) {
    const conditions = [
      field.visibleWhen,
      field.requiredWhen,
      field.validation?.requiredWhen,
    ].filter(Boolean);
    for (const condition of conditions) {
      for (const reference of referencedFields(condition)) {
        if (graph.has(reference)) graph.get(field.key).add(reference);
      }
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (key) => {
    if (visiting.has(key)) {
      throw new AppError('Conditional rules cannot contain circular dependencies.', 400, 'VALIDATION_ERROR');
    }
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of graph.get(key) || []) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of graph.keys()) visit(key);
};

export const evaluateFields = (fields, details) => fields.map((field) => {
  const definition = typeof field.toObject === 'function' ? field.toObject() : field;
  const requiredWhen = definition.requiredWhen || definition.validation?.requiredWhen;
  return {
    ...definition,
    visible: evaluateCondition(definition.visibleWhen, details),
    effectiveRequired: definition.required || Boolean(requiredWhen) && evaluateCondition(requiredWhen, details),
  };
});
