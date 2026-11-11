import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authenticate } from '../../middleware/authenticate.js';
import { loadRequestAccess } from './request.authorization.js';
import * as controller from './approvalDelegation.controller.js';

const router = Router();
router.use(authenticate, loadRequestAccess);
router.post('/', asyncHandler(controller.createDelegation));
router.get('/', asyncHandler(controller.listDelegations));
router.get('/:delegationId', asyncHandler(controller.getDelegation));
router.patch('/:delegationId', asyncHandler(controller.updateDelegation));
router.post('/:delegationId/revoke', asyncHandler(controller.revokeDelegation));
export default router;
