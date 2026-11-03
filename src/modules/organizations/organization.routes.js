import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requireSuperAdmin } from '../../middleware/authorize.js';
import * as organizationController from './organization.controller.js';

const router = Router();

router.use(authenticate, requireSuperAdmin);

router.post('/', asyncHandler(organizationController.createOrganization));
router.get('/', asyncHandler(organizationController.listOrganizations));
router.get('/:organizationId', asyncHandler(organizationController.getOrganization));
router.patch('/:organizationId', asyncHandler(organizationController.updateOrganization));
router.patch('/:organizationId/activate', asyncHandler(organizationController.activateOrganization));
router.patch('/:organizationId/deactivate', asyncHandler(organizationController.deactivateOrganization));

export default router;
