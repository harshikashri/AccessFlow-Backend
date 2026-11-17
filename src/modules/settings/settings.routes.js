import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authenticate } from '../../middleware/authenticate.js';
import * as controller from './settings.controller.js';

const router = Router();
router.use(authenticate);
router.get('/profile', asyncHandler(controller.getProfile));
router.patch('/profile', asyncHandler(controller.updateProfile));
router.get('/preferences', asyncHandler(controller.getPreferences));
router.patch('/preferences', asyncHandler(controller.updatePreferences));
router.get('/notifications', asyncHandler(controller.getNotificationPreferences));
router.patch('/notifications', asyncHandler(controller.updateNotificationPreferences));
router.get('/sessions', asyncHandler(controller.listSessions));
router.post('/sessions/:sessionId/revoke', asyncHandler(controller.revokeSession));
router.get('/organization', asyncHandler(controller.getOrganizationSettings));

export default router;
