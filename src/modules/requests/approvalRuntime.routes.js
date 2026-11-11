import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authenticate } from '../../middleware/authenticate.js';
import { loadRequestAccess } from './request.authorization.js';
import * as controller from './approvalRuntime.controller.js';

const router = Router();

router.use(authenticate, loadRequestAccess);
router.get('/inbox', asyncHandler(controller.listApprovalInbox));
router.get('/:approvalStepId', asyncHandler(controller.getApprovalDetails));
router.post('/:approvalStepId/claim', asyncHandler(controller.claimApproval));
router.post('/:approvalStepId/approve', asyncHandler(controller.approveApproval));
router.post('/:approvalStepId/reject', asyncHandler(controller.rejectApproval));
router.post('/:approvalStepId/return', asyncHandler(controller.returnApproval));

export default router;
