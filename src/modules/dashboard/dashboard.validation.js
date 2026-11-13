import { AppError } from '../../utils/AppError.js';
import { DASHBOARD_DATE_RANGE_OPTIONS } from './dashboard.constants.js';
import { normalizeDateRange } from './dashboard.utils.js';

export const validateDashboardConfigQuery = (query = {}) => {
  const unknown = Object.keys(query);
  if (unknown.length) {
    throw new AppError('Dashboard configuration does not accept query parameters.', 400, 'VALIDATION_ERROR', unknown);
  }
};

export const validateDateRange = (input, now = new Date()) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError('Date range must be an object.', 400, 'VALIDATION_ERROR');
  }
  const allowed = ['range', 'fromDate', 'toDate'];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new AppError('Unsupported date range fields.', 400, 'VALIDATION_ERROR', unknown);
  }
  if (!DASHBOARD_DATE_RANGE_OPTIONS.includes(input.range)) {
    throw new AppError('Unsupported date range.', 400, 'VALIDATION_ERROR');
  }
  if (input.range === 'CUSTOM') {
    if (input.fromDate === undefined || input.toDate === undefined) {
      throw new AppError('Custom date ranges require fromDate and toDate.', 400, 'VALIDATION_ERROR');
    }
  } else if (input.fromDate !== undefined || input.toDate !== undefined) {
    throw new AppError('fromDate and toDate are only supported with the CUSTOM range.', 400, 'VALIDATION_ERROR');
  }
  return normalizeDateRange(input, now);
};

export const validateDashboardSummaryQuery = (query = {}) => {
  const allowed = ['range', 'fromDate', 'toDate'];
  const unknown = Object.keys(query).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new AppError('Unsupported dashboard summary query parameters.', 400, 'VALIDATION_ERROR', unknown);
  }
  const range = query.range === undefined ? 'LAST_30_DAYS' : query.range;
  const fromDate = query.fromDate;
  const toDate = query.toDate;
  if (typeof range !== 'string' || (fromDate !== undefined && typeof fromDate !== 'string') ||
      (toDate !== undefined && typeof toDate !== 'string')) {
    throw new AppError('Dashboard date range query parameters must be single strings.', 400, 'VALIDATION_ERROR');
  }
  return validateDateRange({
    range,
    ...(fromDate !== undefined ? { fromDate } : {}),
    ...(toDate !== undefined ? { toDate } : {}),
  });
};

export default { validateDashboardConfigQuery, validateDateRange, validateDashboardSummaryQuery };
