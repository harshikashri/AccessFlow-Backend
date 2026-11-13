import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authenticate } from '../../middleware/authenticate.js';
import * as dashboardController from './dashboard.controller.js';

const router = Router();

router.get('/config', authenticate, asyncHandler(dashboardController.getDashboardConfig));
router.get('/summary', authenticate, asyncHandler(dashboardController.getDashboardSummary));
router.get('/organization-analytics', authenticate, asyncHandler(dashboardController.getOrganizationAnalytics));
router.get('/user-analytics', authenticate, asyncHandler(dashboardController.getUserAnalytics));
router.get('/request-analytics', authenticate, asyncHandler(dashboardController.getRequestAnalytics));
router.get('/approval-analytics', authenticate, asyncHandler(dashboardController.getApprovalAnalytics));
router.get('/department-analytics', authenticate, asyncHandler(dashboardController.getDepartmentAnalytics));
router.get('/recent-activity', authenticate, asyncHandler(dashboardController.getRecentActivity));

export default router;