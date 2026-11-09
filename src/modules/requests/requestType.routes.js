import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authenticate } from '../../middleware/authenticate.js';
import { loadRequestAccess, requireRequestPermission } from './request.authorization.js';
import * as requestTypeController from './requestType.controller.js';

const router = Router();

router.use(authenticate, loadRequestAccess);
router.get('/', asyncHandler(requestTypeController.listRequestTypes));
router.get('/:requestTypeId', asyncHandler(requestTypeController.getRequestType));
router.post('/', requireRequestPermission('requestTypes.manage'), asyncHandler(requestTypeController.createRequestType));
router.patch('/:requestTypeId', requireRequestPermission('requestTypes.manage'), asyncHandler(requestTypeController.updateRequestType));
router.patch('/:requestTypeId/activate', requireRequestPermission('requestTypes.manage'), asyncHandler(requestTypeController.activateRequestType));
router.patch('/:requestTypeId/deactivate', requireRequestPermission('requestTypes.manage'), asyncHandler(requestTypeController.deactivateRequestType));

export default router;
