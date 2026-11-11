import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authenticate } from '../../middleware/authenticate.js';
import { loadWorkflowAccess, requireWorkflowPermission } from './approvalWorkflow.authorization.js';
import * as controller from './approvalWorkflow.controller.js';

const router = Router();

router.use(authenticate, loadWorkflowAccess);
router.post('/validate', requireWorkflowPermission('workflows.manage'), asyncHandler(controller.validateWorkflow));
router.get('/', requireWorkflowPermission('workflows.view'), asyncHandler(controller.listWorkflows));
router.post('/', requireWorkflowPermission('workflows.manage'), asyncHandler(controller.createWorkflow));
router.get('/:workflowId', requireWorkflowPermission('workflows.view'), asyncHandler(controller.getWorkflow));
router.patch('/:workflowId', requireWorkflowPermission('workflows.manage'), asyncHandler(controller.updateWorkflow));
router.patch('/:workflowId/activate', requireWorkflowPermission('workflows.manage'), asyncHandler(controller.setWorkflowStatus(true)));
router.patch('/:workflowId/deactivate', requireWorkflowPermission('workflows.manage'), asyncHandler(controller.setWorkflowStatus(false)));

export default router;
