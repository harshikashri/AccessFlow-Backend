import { DASHBOARD_TIME_ZONE } from '../dashboard.constants.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const groupingForRange = (dateRange) => {
  const duration = dateRange.toDate.getTime() - dateRange.fromDate.getTime();
  if (duration <= 31 * DAY_MS) return 'day';
  if (duration <= 120 * DAY_MS) return 'week';
  return 'month';
};

const periodStart = (date, unit) => {
  const value = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  if (unit === 'week') {
    const daysSinceMonday = (value.getUTCDay() + 6) % 7;
    value.setUTCDate(value.getUTCDate() - daysSinceMonday);
  } else if (unit === 'month') {
    value.setUTCDate(1);
  }
  return value;
};

const incrementPeriod = (date, unit) => {
  const next = new Date(date);
  if (unit === 'day') next.setUTCDate(next.getUTCDate() + 1);
  if (unit === 'week') next.setUTCDate(next.getUTCDate() + 7);
  if (unit === 'month') next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
};

export const buildPeriods = (dateRange, unit = groupingForRange(dateRange)) => {
  const periods = [];
  for (
    let start = periodStart(dateRange.fromDate, unit);
    start < dateRange.toDate;
    start = incrementPeriod(start, unit)
  ) {
    periods.push({
      period: unit === 'month'
        ? start.toISOString().slice(0, 7)
        : start.toISOString().slice(0, 10),
      periodStart: start,
      count: 0,
    });
  }
  return periods;
};

export const percentageChange = (current, previous) => ({
  absoluteDifference: current - previous,
  percentageChange: previous === 0 ? null : Number((((current - previous) / previous) * 100).toFixed(2)),
});

export const publicDateRange = (dateRange) => ({
  range: dateRange.range,
  fromDate: dateRange.fromDate.toISOString(),
  toDate: dateRange.toDate.toISOString(),
  timeZone: DASHBOARD_TIME_ZONE,
  interval: '[fromDate, toDate)',
});

export default { groupingForRange, buildPeriods, percentageChange, publicDateRange };
