import { AppError } from '../../../utils/AppError.js';
import { validateDateRange } from '../dashboard.validation.js';
import { publicDateRange } from './analytics.utils.js';

export const validateAnalyticsQuery = (query = {}, { pagination = false } = {}) => {
  const allowed = ['range', 'fromDate', 'toDate', ...(pagination ? ['page', 'limit'] : [])];
  const unknown = Object.keys(query).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new AppError('Unsupported dashboard analytics query parameters.', 400, 'VALIDATION_ERROR', unknown);
  }
  const range = query.range === undefined ? 'LAST_30_DAYS' : query.range;
  if (typeof range !== 'string' ||
      (query.fromDate !== undefined && typeof query.fromDate !== 'string') ||
      (query.toDate !== undefined && typeof query.toDate !== 'string')) {
    throw new AppError('Date range query parameters must be single strings.', 400, 'VALIDATION_ERROR');
  }
  const dateRange = validateDateRange({
    range,
    ...(query.fromDate !== undefined ? { fromDate: query.fromDate } : {}),
    ...(query.toDate !== undefined ? { toDate: query.toDate } : {}),
  });
  if (!pagination) return { dateRange };

  const parseInteger = (value, name, fallback, max) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
      throw new AppError(`${name} must be a positive integer.`, 400, 'VALIDATION_ERROR');
    }
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number > max) {
      throw new AppError(`${name} cannot exceed ${max}.`, 400, 'VALIDATION_ERROR');
    }
    if (name === 'page' && (number - 1) * (Number(query.limit) || 10) > Number.MAX_SAFE_INTEGER) {
      throw new AppError('Requested page offset is too large.', 400, 'VALIDATION_ERROR');
    }
    return number;
  };
  const limit = parseInteger(query.limit, 'limit', 10, 100);
  const page = parseInteger(query.page, 'page', 1, Number.MAX_SAFE_INTEGER);
  return {
    dateRange,
    page,
    limit,
  };
};

export const serializeDateRange = publicDateRange;

export default { validateAnalyticsQuery, serializeDateRange };
