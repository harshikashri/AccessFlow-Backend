import * as auditService from './audit.service.js';
import { validateAuditId, validateAuditListQuery } from './audit.validation.js';

export const listAuditLogs = async (req, res) => {
  const query = validateAuditListQuery(req.query);
  const data = await auditService.listAuditLogs({ auth: req.auth, access: req.userAccess, query });
  return res.status(200).json({ success: true, message: 'Audit logs retrieved successfully.', data });
};

export const listSuperAdminAuditLogs = async (req, res) => {
  const query = validateAuditListQuery(req.query);
  const data = await auditService.listSuperAdminAuditLogs({ auth: req.auth, query });
  return res.status(200).json({ success: true, message: 'Super Admin audit logs retrieved successfully.', data });
};

export const getAuditLog = async (req, res) => {
  const data = await auditService.getAuditLog({
    auth: req.auth,
    access: req.userAccess,
    auditLogId: validateAuditId(req.params.auditLogId),
  });
  return res.status(200).json({ success: true, message: 'Audit event retrieved successfully.', data });
};

export const getAuditStatistics = async (req, res) => {
  const query = validateAuditListQuery({ ...req.query, page: 1, limit: 1 });
  const data = await auditService.getAuditStatistics({ auth: req.auth, access: req.userAccess, query });
  return res.status(200).json({ success: true, message: 'Audit statistics retrieved successfully.', data });
};

export const exportAuditLogs = async (req, res) => {
  const query = validateAuditListQuery({ ...req.query, page: 1, limit: 100 });
  const csv = await auditService.exportAuditLogs({ auth: req.auth, access: req.userAccess, query });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="accessflow-audit-${new Date().toISOString().slice(0, 10)}.csv"`);
  return res.status(200).send(`\uFEFF${csv}`);
};
