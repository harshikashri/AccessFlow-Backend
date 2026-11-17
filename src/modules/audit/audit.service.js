import AuditLog from '../../models/AuditLog.js';
import User from '../../models/User.js';
import { AUDIT_ACTIONS, AUDIT_RESOURCE_TYPES } from '../../config/constants.js';
import { AppError } from '../../utils/AppError.js';
import { hasEffectivePermission } from '../../services/authorization/permission.service.js';

const SENSITIVE_KEYS = /password|token|secret|credential|apiKey|accessKey|refresh/i;

const PLATFORM_AUDIT_EVENTS = [
  {
    resourceType: AUDIT_RESOURCE_TYPES.ORGANIZATION,
    action: {
      $in: [
        AUDIT_ACTIONS.ORGANIZATION_CREATED,
        AUDIT_ACTIONS.ORGANIZATION_UPDATED,
        AUDIT_ACTIONS.ORGANIZATION_ACTIVATED,
        AUDIT_ACTIONS.ORGANIZATION_DEACTIVATED,
      ],
    },
  },
  {
    resourceType: AUDIT_RESOURCE_TYPES.USER,
    action: AUDIT_ACTIONS.ORGANIZATION_ADMIN_CREATED,
  },
];

const safeValue = (value) => {
  if (Array.isArray(value)) return value.map(safeValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      SENSITIVE_KEYS.test(key) ? '[REDACTED]' : safeValue(child),
    ])
  );
};

const publicAudit = (log) => ({
  id: String(log._id),
  organizationId: log.organizationId ? String(log.organizationId) : null,
  departmentId: log.departmentId ? String(log.departmentId) : null,
  actorId: log.actorId
    ? String(typeof log.actorId === 'object' ? log.actorId._id : log.actorId)
    : null,
  actorPlatformRole: log.actorPlatformRole || null,
  actor: log.actorId && typeof log.actorId === 'object'
    ? { id: String(log.actorId._id), name: log.actorId.name, email: log.actorId.email }
    : null,
  action: log.action,
  resourceType: log.resourceType,
  resourceId: String(log.resourceId),
  organization: log.organizationId && typeof log.organizationId === 'object'
    ? { id: String(log.organizationId._id), name: log.organizationId.name }
    : null,
  department: log.departmentId && typeof log.departmentId === 'object'
    ? { id: String(log.departmentId._id), name: log.departmentId.name }
    : null,
  changes: safeValue(log.changes || {}),
  metadata: safeValue(log.metadata || {}),
  result: log.result || null,
  status: log.status || null,
  timestamp: log.timestamp,
});

const allowedOrganizationIds = ({ auth, access }) => {
  if (auth.platformRole === 'SUPER_ADMIN' && !auth.organizationId) return null;
  if (access.organizationPermissions.has('audit_logs.view')) return { organizationId: auth.organizationId };
  const departmentIds = access.scopedPermissions.get('audit_logs.view');
  if (!departmentIds?.size) {
    throw new AppError('Permission audit_logs.view is required for this operation.', 403, 'FORBIDDEN');
  }
  return { organizationId: auth.organizationId, departmentId: { $in: [...departmentIds] } };
};

const buildFilter = ({ auth, access, query }) => {
  const scope = allowedOrganizationIds({ auth, access });
  const filter = scope ? { ...scope } : {};
  if (query.organizationId) {
    if (scope?.organizationId && String(query.organizationId) !== String(scope.organizationId)) {
      throw new AppError('Audit organization is outside your scope.', 403, 'FORBIDDEN');
    }
    filter.organizationId = query.organizationId;
  }
  for (const key of ['actorId', 'action', 'resourceType', 'resourceId', 'departmentId', 'result', 'status']) {
    if (query[key] !== undefined) filter[key] = query[key];
  }
  if (query.search) {
    const escaped = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { action: { $regex: escaped, $options: 'i' } },
      { resourceType: { $regex: escaped, $options: 'i' } },
      { resourceId: { $regex: escaped, $options: 'i' } },
    ];
  }
  if (query.fromDate || query.toDate) {
    filter.timestamp = {};
    if (query.fromDate) filter.timestamp.$gte = query.fromDate;
    if (query.toDate) filter.timestamp.$lte = query.toDate;
  }
  return filter;
};

const populateAudit = (query) => query
  .populate({ path: 'actorId', select: 'name email' })
  .populate({ path: 'organizationId', select: 'name' })
  .populate({ path: 'departmentId', select: 'name' });

const listAuditLogsWithFilter = async (filter, query, format = publicAudit, idSortOrder = 1) => {
  const sort = { [query.sortBy]: query.sortOrder === 'asc' ? 1 : -1, _id: idSortOrder };
  const [items, total] = await Promise.all([
    populateAudit(AuditLog.find(filter).sort(sort).skip((query.page - 1) * query.limit).limit(query.limit).lean()),
    AuditLog.countDocuments(filter),
  ]);
  return {
    items: items.map(format),
    pagination: { page: query.page, limit: query.limit, total, totalPages: total ? Math.ceil(total / query.limit) : 0 },
  };
};

const platformDescription = (log) => {
  const targetName = typeof log.changes?.name === 'string'
    ? log.changes.name
    : log.changes?.name?.to;
  return `${log.action.replaceAll('_', ' ')} — ${targetName || log.resourceType}`;
};

export const listAuditLogs = async ({ auth, access, query }) => {
  const filter = buildFilter({ auth, access, query });
  return listAuditLogsWithFilter(filter, query);
};

export const listSuperAdminAuditLogs = async ({ auth, query }) => {
  const legacyActorIds = await User.find({ platformRole: 'SUPER_ADMIN' }).distinct('_id');
  const filter = buildFilter({ auth, access: null, query });
  filter.$and = [
    ...(filter.$and || []),
    {
      $or: [
        { actorPlatformRole: 'SUPER_ADMIN' },
        { actorPlatformRole: { $exists: false }, actorId: { $in: legacyActorIds } },
      ],
    },
    { $or: PLATFORM_AUDIT_EVENTS },
  ];
  return listAuditLogsWithFilter(
    filter,
    query,
    (log) => ({ ...publicAudit(log), description: platformDescription(log) }),
    -1,
  );
};

export const getAuditLog = async ({ auth, access, auditLogId }) => {
  const filter = buildFilter({ auth, access, query: {} });
  filter._id = auditLogId;
  const log = await populateAudit(AuditLog.findOne(filter).lean());
  if (!log) throw new AppError('Audit event not found.', 404, 'AUDIT_NOT_FOUND');
  return publicAudit(log);
};

export const getAuditStatistics = async ({ auth, access, query }) => {
  const filter = buildFilter({ auth, access, query });
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const startOfWeek = new Date(startOfDay);
  startOfWeek.setDate(startOfWeek.getDate() - 6);
  const [total, today, week, byAction] = await Promise.all([
    AuditLog.countDocuments(filter),
    AuditLog.countDocuments({ ...filter, timestamp: { ...(filter.timestamp || {}), $gte: startOfDay } }),
    AuditLog.countDocuments({ ...filter, timestamp: { ...(filter.timestamp || {}), $gte: startOfWeek } }),
    AuditLog.aggregate([{ $match: filter }, { $group: { _id: '$action', count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 10 }]),
  ]);
  return { total, today, week, byAction: byAction.map((item) => ({ action: item._id, count: item.count })) };
};

export const exportAuditLogs = async ({ auth, access, query }) => {
  const filter = buildFilter({ auth, access, query });
  const logs = await populateAudit(AuditLog.find(filter).sort({ timestamp: -1 }).limit(10000).lean());
  const escape = (value) => {
    const text = String(value ?? '');
    const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  const rows = [
    ['Timestamp', 'Actor', 'Action', 'Resource type', 'Resource ID', 'Organization', 'Department', 'Result', 'Status'],
    ...logs.map((log) => {
      const item = publicAudit(log);
      return [
        item.timestamp?.toISOString?.() || item.timestamp,
        item.actor?.name || item.actorId,
        item.action,
        item.resourceType,
        item.resourceId,
        item.organization?.name || item.organizationId,
        item.department?.name || item.departmentId,
        item.result,
        item.status,
      ];
    }),
  ];
  return rows.map((row) => row.map(escape).join(',')).join('\r\n');
};

export default { listAuditLogs, listSuperAdminAuditLogs, getAuditLog, getAuditStatistics, exportAuditLogs };
