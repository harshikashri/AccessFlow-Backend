import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authenticate } from '../../middleware/authenticate.js';
import { loadRequestAccess } from './request.authorization.js';
import * as controller from './approvalRuntime.controller.js';
import { sensitiveOperationRateLimiter } from '../../middleware/rateLimiters.js';

const router = Router();

router.use(authenticate, loadRequestAccess);
router.get('/inbox', asyncHandler(controller.listApprovalInbox));
router.get('/:approvalStepId', asyncHandler(controller.getApprovalDetails));
router.post(
  '/:approvalStepId/claim',
  sensitiveOperationRateLimiter,
  asyncHandler(controller.claimApproval),
);
router.post(
  '/:approvalStepId/approve',
  sensitiveOperationRateLimiter,
  asyncHandler(controller.approveApproval),
);
router.post(
  '/:approvalStepId/reject',
  sensitiveOperationRateLimiter,
  asyncHandler(controller.rejectApproval),
);
router.post(
  '/:approvalStepId/return',
  sensitiveOperationRateLimiter,
  asyncHandler(controller.returnApproval),
);

export default router;
