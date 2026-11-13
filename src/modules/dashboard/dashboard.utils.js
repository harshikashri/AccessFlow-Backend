import { AppError } from '../../utils/AppError.js';
import {
  DASHBOARD_TIME_ZONE,
  MAX_CUSTOM_DATE_RANGE_DAYS,
} from './dashboard.constants.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_UTC_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/;

const parseUtcDate = (value, label, endExclusive = false) => {
  if (typeof value !== 'string' || (!ISO_DATE.test(value) && !ISO_UTC_DATETIME.test(value))) {
    throw new AppError(`${label} must be an ISO 8601 UTC date or datetime.`, 400, 'VALIDATION_ERROR');
  }
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== month - 1 ||
    calendarDate.getUTCDate() !== day
  ) {
    throw new AppError(`${label} must be a valid calendar date.`, 400, 'VALIDATION_ERROR');
  }
  if (ISO_UTC_DATETIME.test(value)) {
    const [hour, minute, second = '0'] = value.slice(11, -1).split(':');
    const seconds = Number(second.split('.')[0]);
    if (Number(hour) > 23 || Number(minute) > 59 || seconds > 59) {
      throw new AppError(`${label} must be a valid time.`, 400, 'VALIDATION_ERROR');
    }
  }
  const date = new Date(ISO_DATE.test(value) ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError(`${label} must be a valid date.`, 400, 'VALIDATION_ERROR');
  }
  if (ISO_DATE.test(value) && endExclusive) date.setUTCDate(date.getUTCDate() + 1);
  return date;
};

const startOfUtcMonth = (date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
const startOfUtcYear = (date) => new Date(Date.UTC(date.getUTCFullYear(), 0, 1));

export const normalizeDateRange = (input, now = new Date()) => {
  const current = new Date(now);
  if (Number.isNaN(current.getTime())) {
    throw new AppError('Current date must be valid.', 500, 'INVALID_DATE_CONFIGURATION');
  }
  let fromDate;
  let toDate = current;
  switch (input.range) {
    case 'LAST_7_DAYS':
      fromDate = new Date(current.getTime() - 7 * DAY_MS);
      break;
    case 'LAST_30_DAYS':
      fromDate = new Date(current.getTime() - 30 * DAY_MS);
      break;
    case 'LAST_90_DAYS':
      fromDate = new Date(current.getTime() - 90 * DAY_MS);
      break;
    case 'THIS_MONTH':
      fromDate = startOfUtcMonth(current);
      break;
    case 'THIS_YEAR':
      fromDate = startOfUtcYear(current);
      break;
    case 'CUSTOM':
      fromDate = parseUtcDate(input.fromDate, 'fromDate');
      toDate = parseUtcDate(input.toDate, 'toDate', ISO_DATE.test(input.toDate));
      if (ISO_DATE.test(input.toDate) &&
          input.toDate === current.toISOString().slice(0, 10)) {
        toDate = current;
      }
      break;
    default:
      throw new AppError('Unsupported date range.', 400, 'VALIDATION_ERROR');
  }
  if (fromDate >= toDate) {
    throw new AppError('fromDate must be earlier than toDate.', 400, 'VALIDATION_ERROR');
  }
  if (toDate > current) {
    throw new AppError('Date range cannot end in the future.', 400, 'VALIDATION_ERROR');
  }
  if (input.range === 'CUSTOM' &&
      toDate.getTime() - fromDate.getTime() > MAX_CUSTOM_DATE_RANGE_DAYS * DAY_MS) {
    throw new AppError(`Custom date ranges cannot exceed ${MAX_CUSTOM_DATE_RANGE_DAYS} days.`, 400, 'VALIDATION_ERROR');
  }
  return {
    range: input.range,
    fromDate,
    toDate,
    timeZone: DASHBOARD_TIME_ZONE,
    interval: '[fromDate, toDate)',
  };
};

export default { normalizeDateRange };
