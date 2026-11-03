import mongoose from 'mongoose';

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
    changes: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
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
