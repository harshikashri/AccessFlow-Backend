import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authenticate } from '../../middleware/authenticate.js';
import { loadRequestAccess } from './request.authorization.js';
import * as requestController from './request.controller.js';

const router = Router();

router.use(authenticate, loadRequestAccess);
router.post('/', asyncHandler(requestController.createRequest));
router.get('/search', asyncHandler(requestController.searchRequests));
router.get('/', asyncHandler(requestController.listRequests));
router.get('/:requestId', asyncHandler(requestController.getRequest));
router.patch('/:requestId', asyncHandler(requestController.updateRequest));
router.post('/:requestId/submit', asyncHandler(requestController.submitRequest));
router.post('/:requestId/resubmit', asyncHandler(requestController.resubmitRequest));
router.post('/:requestId/cancel', asyncHandler(requestController.cancelRequest));
router.get('/:requestId/approval-progress', asyncHandler(requestController.getApprovalProgress));
router.get('/:requestId/approval-history', asyncHandler(requestController.getApprovalHistory));

export default router;