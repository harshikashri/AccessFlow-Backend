import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authenticate } from '../../middleware/authenticate.js';
import {
	loadRoleManagementAccess,
	requireRoleManagementPermission,
} from './role.authorization.js';
import * as roleController from './role.controller.js';

const router = Router();

router.use(authenticate, loadRoleManagementAccess);

router.get(
	'/permissions/catalog',
	requireRoleManagementPermission('roles.view'),
	asyncHandler(roleController.getPermissionCatalog)
);
router.get(
	'/users/:userId',
	requireRoleManagementPermission('roles.view'),
	asyncHandler(roleController.listUserRoleAssignments)
);
router.post('/', requireRoleManagementPermission('roles.create'), asyncHandler(roleController.createRole));
router.get('/', requireRoleManagementPermission('roles.view'), asyncHandler(roleController.listRoles));
router.get(
	'/:roleId/users',
	requireRoleManagementPermission('roles.view'),
	asyncHandler(roleController.listRoleUsers)
);
router.get('/:roleId', requireRoleManagementPermission('roles.view'), asyncHandler(roleController.getRole));
router.patch('/:roleId', requireRoleManagementPermission('roles.edit'), asyncHandler(roleController.updateRole));
router.patch(
	'/:roleId/permissions',
	requireRoleManagementPermission('roles.edit'),
	asyncHandler(roleController.updateRolePermissions)
);
router.patch(
	'/:roleId/activate',
	requireRoleManagementPermission('roles.edit'),
	asyncHandler(roleController.activateRole)
);
router.patch(
	'/:roleId/deactivate',
	requireRoleManagementPermission('roles.edit'),
	asyncHandler(roleController.deactivateRole)
);
router.post(
	'/:roleId/assign',
	requireRoleManagementPermission('roles.edit'),
	asyncHandler(roleController.assignRole)
);
router.delete(
	'/:roleId/assign/:userId',
	requireRoleManagementPermission('roles.edit'),
	asyncHandler(roleController.removeRoleAssignment)
);

export default router;
