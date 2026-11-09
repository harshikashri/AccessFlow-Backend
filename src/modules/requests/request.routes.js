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
router.post('/:requestId/cancel', asyncHandler(requestController.cancelRequest));

export default router;