import mongoose from 'mongoose';

const organizationMembershipSchema = new mongoose.Schema(
  {
    membershipId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      default: () => new mongoose.Types.ObjectId(),
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
    },
    departmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Department',
      default: null,
    },
    status: {
      type: String,
      enum: ['ACTIVE', 'INACTIVE'],
      default: 'ACTIVE',
    },
  },
  { _id: false }
);

const approvalDelegationSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    delegateId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    scopeType: { type: String, enum: ['ORGANIZATION', 'DEPARTMENT'], default: 'ORGANIZATION' },
    departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', default: null },
    stageIds: { type: [String], default: [] },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    status: { type: String, enum: ['ACTIVE', 'REVOKED'], default: 'ACTIVE' },
    revokedAt: { type: Date, default: null },
    revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

const userPreferencesSchema = new mongoose.Schema(
  {
    language: { type: String, trim: true, maxlength: 20, default: 'en' },
    timezone: { type: String, trim: true, maxlength: 100, default: 'UTC' },
    dateFormat: { type: String, trim: true, maxlength: 30, default: 'YYYY-MM-DD' },
    timeFormat: { type: String, enum: ['12h', '24h'], default: '24h' },
    notifications: {
      approvalTasks: { type: Boolean, default: true },
      requestUpdates: { type: Boolean, default: true },
      delegationUpdates: { type: Boolean, default: true },
      slaReminders: { type: Boolean, default: true },
      overdueAlerts: { type: Boolean, default: true },
      escalationAlerts: { type: Boolean, default: true },
      email: { type: Boolean, default: true },
      inApp: { type: Boolean, default: true },
    },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 200,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    },
    passwordHash: {
      type: String,
      required: true,
    },
    passwordSetupRequired: {
      type: Boolean,
      default: false,
    },
    passwordSetupTokenHash: {
      type: String,
      select: false,
    },
    passwordSetupTokenExpiresAt: {
      type: Date,
      select: false,
    },
    passwordResetTokenHash: {
      type: String,
      select: false,
    },
    passwordResetTokenExpiresAt: {
      type: Date,
      select: false,
    },
    organizationMemberships: [organizationMembershipSchema],
    approvalDelegations: { type: [approvalDelegationSchema], default: [] },
    accountStatus: {
      type: String,
      enum: ['ACTIVE', 'INACTIVE'],
      default: 'ACTIVE',
    },
    platformRole: {
      type: String,
      enum: ['SUPER_ADMIN', null],
      default: null,
    },
    preferences: {
      type: userPreferencesSchema,
      default: () => ({}),
    },
  },
  { timestamps: true }
);

const User = mongoose.model('User', userSchema, 'users');

export default User;
