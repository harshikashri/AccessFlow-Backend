import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authenticate } from '../../middleware/authenticate.js';
import { loadUserPermissions, requireUserPermission } from './user.authorization.js';
import * as userController from './user.controller.js';

const router = Router();

router.use(authenticate, loadUserPermissions);

router.post(
	'/',
	requireUserPermission('users.create', { organizationWideOnly: true }),
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
	asyncHandler(userController.initiatePasswordReset)
);

export default router;
