import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authenticate } from '../../middleware/authenticate.js';
import { loadRequestAccess } from './request.authorization.js';
import * as requestController from './request.controller.js';
import { sensitiveOperationRateLimiter } from '../../middleware/rateLimiters.js';

const router = Router();

router.use(authenticate, loadRequestAccess);
router.post('/', sensitiveOperationRateLimiter, asyncHandler(requestController.createRequest));
router.get('/search', asyncHandler(requestController.searchRequests));
router.get('/', asyncHandler(requestController.listRequests));
router.get('/:requestId', asyncHandler(requestController.getRequest));
router.patch(
  '/:requestId',
  sensitiveOperationRateLimiter,
  asyncHandler(requestController.updateRequest),
);
router.post(
  '/:requestId/submit',
  sensitiveOperationRateLimiter,
  asyncHandler(requestController.submitRequest),
);
router.post(
  '/:requestId/resubmit',
  sensitiveOperationRateLimiter,
  asyncHandler(requestController.resubmitRequest),
);
router.post(
  '/:requestId/cancel',
  sensitiveOperationRateLimiter,
  asyncHandler(requestController.cancelRequest),
);
router.get('/:requestId/approval-progress', asyncHandler(requestController.getApprovalProgress));
router.get('/:requestId/approval-history', asyncHandler(requestController.getApprovalHistory));

export default router;