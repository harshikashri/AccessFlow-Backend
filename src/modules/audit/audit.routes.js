import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requireSuperAdmin } from '../../middleware/authorize.js';
import { loadUserPermissions } from '../users/user.authorization.js';
import * as auditController from './audit.controller.js';

const router = Router();

router.use(authenticate);
router.use((req, res, next) => {
  if (req.auth?.platformRole === 'SUPER_ADMIN' && !req.auth.organizationId) return next();
  return loadUserPermissions(req, res, next);
});
router.get('/platform', requireSuperAdmin, asyncHandler(auditController.listSuperAdminAuditLogs));
router.get('/', asyncHandler(auditController.listAuditLogs));
router.get('/statistics', asyncHandler(auditController.getAuditStatistics));
router.get('/export', asyncHandler(auditController.exportAuditLogs));
router.get('/:auditLogId', asyncHandler(auditController.getAuditLog));

export default router;
