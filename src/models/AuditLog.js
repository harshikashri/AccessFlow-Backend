import mongoose from 'mongoose';

const SENSITIVE_KEYS = /password|token|secret|credential|apiKey|accessKey|refresh/i;

const sanitizeAuditValue = (value, seen = new WeakSet()) => {
  if (Array.isArray(value)) return value.map((item) => sanitizeAuditValue(item, seen));
  if (!value || typeof value !== 'object') return value;
  if (value instanceof Date || value instanceof mongoose.Types.ObjectId) return value;
  if (typeof value.toObject === 'function') {
    return sanitizeAuditValue(value.toObject({ depopulate: true }), seen);
  }
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      SENSITIVE_KEYS.test(key) ? '[REDACTED]' : sanitizeAuditValue(child, seen),
    ])
  );
};

const auditLogSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      default: null,
    },
    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    action: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    resourceType: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    resourceId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    departmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Department',
      default: null,
    },
    changes: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
      set: sanitizeAuditValue,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
      set: sanitizeAuditValue,
    },
    result: { type: String, trim: true, maxlength: 100, default: null },
    status: { type: String, trim: true, maxlength: 100, default: null },
    timestamp: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: false }
);

auditLogSchema.index({ organizationId: 1, timestamp: -1 });
auditLogSchema.index({ actorId: 1, timestamp: -1 });
auditLogSchema.index({ resourceType: 1, resourceId: 1, timestamp: -1 });
auditLogSchema.index({ organizationId: 1, departmentId: 1, timestamp: -1 });

const APPEND_ONLY_ERROR = 'Audit logs are append-only and cannot be modified or deleted.';

auditLogSchema.pre('save', function preventAuditLogUpdate(next) {
  if (!this.isNew) {
    return next(new Error(APPEND_ONLY_ERROR));
  }
  return next();
});

auditLogSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete'],
  function preventAuditLogMutation() {
    throw new Error(APPEND_ONLY_ERROR);
  }
);

const AuditLog = mongoose.model('AuditLog', auditLogSchema, 'auditLogs');

export default AuditLog;
