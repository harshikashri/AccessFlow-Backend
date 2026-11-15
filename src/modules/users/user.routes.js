import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authenticate } from '../../middleware/authenticate.js';
import { loadUserPermissions, requireUserPermission } from './user.authorization.js';
import * as userController from './user.controller.js';
import { loadBulkUserCsv } from './bulk-user-upload.middleware.js';
import {
	bulkOperationRateLimiter,
	sensitiveOperationRateLimiter,
} from '../../middleware/rateLimiters.js';

const router = Router();

router.use(authenticate, loadUserPermissions);

router.get(
	'/bulk-import/template',
	requireUserPermission('users.create', { organizationWideOnly: true }),
	asyncHandler(userController.downloadBulkImportTemplate)
);
router.post(
	'/bulk-import/validate',
	requireUserPermission('users.create', { organizationWideOnly: true }),
	bulkOperationRateLimiter,
	loadBulkUserCsv,
	asyncHandler(userController.validateBulkImport)
);
router.post(
	'/bulk-import/confirm',
	requireUserPermission('users.create', { organizationWideOnly: true }),
	bulkOperationRateLimiter,
	loadBulkUserCsv,
	asyncHandler(userController.confirmBulkImport)
);
router.post(
	'/bulk-import/failed-report',
	requireUserPermission('users.create', { organizationWideOnly: true }),
	bulkOperationRateLimiter,
	loadBulkUserCsv,
	asyncHandler(userController.downloadBulkImportFailedReport)
);
router.post(
	'/bulk-deactivate',
	requireUserPermission('users.deactivate', { organizationWideOnly: true }),
	bulkOperationRateLimiter,
	asyncHandler(userController.bulkDeactivateUsers)
);
router.post(
	'/bulk-membership-status',
	requireUserPermission('users.deactivate', { organizationWideOnly: true }),
	bulkOperationRateLimiter,
	asyncHandler(userController.bulkSetMembershipStatus)
);
router.post(
	'/',
	requireUserPermission('users.create', { organizationWideOnly: true }),
	sensitiveOperationRateLimiter,
	asyncHandler(userController.createUser)
);
router.get('/', requireUserPermission('users.view'), asyncHandler(userController.listUsers));
router.get('/:userId', requireUserPermission('users.view'), asyncHandler(userController.getUser));
router.patch('/:userId', requireUserPermission('users.edit'), asyncHandler(userController.updateUser));
router.patch(
	'/:userId/department',
	requireUserPermission('users.edit'),
	asyncHandler(userController.assignDepartment)
);
router.patch(
	'/:userId/activate',
	requireUserPermission('users.deactivate'),
	asyncHandler(userController.activateUser)
);
router.patch(
	'/:userId/deactivate',
	requireUserPermission('users.deactivate'),
	asyncHandler(userController.deactivateUser)
);
router.post(
	'/:userId/password-reset',
	requireUserPermission('users.edit'),
	sensitiveOperationRateLimiter,
	asyncHandler(userController.initiatePasswordReset)
);

export default router;
