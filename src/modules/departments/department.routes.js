import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authenticate } from '../../middleware/authenticate.js';
import {
	loadDepartmentPermissions,
	requireDepartmentPermission,
} from './department.authorization.js';
import * as departmentController from './department.controller.js';

const router = Router();

router.use(authenticate, loadDepartmentPermissions);

router.post(
	'/',
	requireDepartmentPermission('departments.create', { organizationWideOnly: true }),
	asyncHandler(departmentController.createDepartment)
);
router.get(
	'/',
	requireDepartmentPermission('departments.view'),
	asyncHandler(departmentController.listDepartments)
);
router.get(
	'/:departmentId',
	requireDepartmentPermission('departments.view'),
	asyncHandler(departmentController.getDepartment)
);
router.patch(
	'/:departmentId',
	requireDepartmentPermission('departments.edit'),
	asyncHandler(departmentController.updateDepartment)
);
router.patch(
	'/:departmentId/managers',
	requireDepartmentPermission('departments.edit'),
	asyncHandler(departmentController.replaceDepartmentManagers)
);
router.post(
	'/:departmentId/members',
	requireDepartmentPermission('departments.edit'),
	asyncHandler(departmentController.addDepartmentMembers)
);
router.delete(
	'/:departmentId/members/:userId',
	requireDepartmentPermission('departments.edit'),
	asyncHandler(departmentController.removeDepartmentMember)
);
router.patch(
	'/:departmentId/activate',
	requireDepartmentPermission('departments.edit'),
	asyncHandler(departmentController.activateDepartment)
);
router.patch(
	'/:departmentId/deactivate',
	requireDepartmentPermission('departments.edit'),
	asyncHandler(departmentController.deactivateDepartment)
);

export default router;
