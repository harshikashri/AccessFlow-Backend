import * as dashboardService from './dashboard.service.js';
import {
  validateDashboardConfigQuery,
  validateDashboardSummaryQuery,
} from './dashboard.validation.js';
import * as analyticsService from './dashboard.analytics.service.js';
import { validateAnalyticsQuery, serializeDateRange } from './analytics/analytics.validation.js';

export const getDashboardConfig = async (req, res) => {
  validateDashboardConfigQuery(req.query);
  const data = await dashboardService.getDashboardConfig({
    userId: req.auth.userId,
    organizationId: req.auth.organizationId,
    platformRole: req.auth.platformRole,
  });
  return res.status(200).json({
    success: true,
    message: 'Dashboard configuration retrieved successfully.',
    data,
  });
};

export const getDashboardSummary = async (req, res) => {
  const dateRange = validateDashboardSummaryQuery(req.query);
  const data = await dashboardService.getDashboardSummary({
    userId: req.auth.userId,
    organizationId: req.auth.organizationId,
    platformRole: req.auth.platformRole,
    dateRange,
  });
  return res.status(200).json({
    success: true,
    message: 'Dashboard summary retrieved successfully.',
    data,
  });
};

export const getOrganizationAnalytics = async (req, res) => {
  const { dateRange } = validateAnalyticsQuery(req.query);
  const data = await analyticsService.organizationAnalytics({
    userId: req.auth.userId,
    organizationId: req.auth.organizationId,
    platformRole: req.auth.platformRole,
    dateRange,
  });
  data.dateRange = serializeDateRange(dateRange);
  return res.status(200).json({ success: true, message: 'Organization analytics retrieved successfully.', data });
};

export const getUserAnalytics = async (req, res) => {
  const { dateRange } = validateAnalyticsQuery(req.query);
  const data = await analyticsService.userAnalytics({
    userId: req.auth.userId,
    organizationId: req.auth.organizationId,
    platformRole: req.auth.platformRole,
    dateRange,
  });
  data.dateRange = serializeDateRange(dateRange);
  return res.status(200).json({ success: true, message: 'User analytics retrieved successfully.', data });
};

export const getRequestAnalytics = async (req, res) => {
  const { dateRange } = validateAnalyticsQuery(req.query);
  const data = await analyticsService.requestAnalytics({
    userId: req.auth.userId,
    organizationId: req.auth.organizationId,
    platformRole: req.auth.platformRole,
    dateRange,
  });
  data.dateRange = serializeDateRange(dateRange);
  return res.status(200).json({ success: true, message: 'Request analytics retrieved successfully.', data });
};

export const getApprovalAnalytics = async (req, res) => {
  const { dateRange } = validateAnalyticsQuery(req.query);
  const data = await analyticsService.approvalAnalytics({
    userId: req.auth.userId,
    organizationId: req.auth.organizationId,
    platformRole: req.auth.platformRole,
    dateRange,
  });
  data.dateRange = serializeDateRange(dateRange);
  return res.status(200).json({ success: true, message: 'Approval analytics retrieved successfully.', data });
};

export const getDepartmentAnalytics = async (req, res) => {
  const { dateRange } = validateAnalyticsQuery(req.query);
  const data = await analyticsService.departmentAnalytics({
    userId: req.auth.userId,
    organizationId: req.auth.organizationId,
    platformRole: req.auth.platformRole,
    dateRange,
  });
  data.dateRange = serializeDateRange(dateRange);
  return res.status(200).json({ success: true, message: 'Department analytics retrieved successfully.', data });
};

export const getRecentActivity = async (req, res) => {
  const { dateRange, page, limit } = validateAnalyticsQuery(req.query, { pagination: true });
  const data = await analyticsService.recentActivity({
    userId: req.auth.userId,
    organizationId: req.auth.organizationId,
    platformRole: req.auth.platformRole,
    dateRange,
    page,
    limit,
  });
  data.dateRange = serializeDateRange(dateRange);
  return res.status(200).json({ success: true, message: 'Recent activity retrieved successfully.', data });
};

export default {
  getDashboardConfig,
  getDashboardSummary,
  getOrganizationAnalytics,
  getUserAnalytics,
  getRequestAnalytics,
  getApprovalAnalytics,
  getDepartmentAnalytics,
  getRecentActivity,
};