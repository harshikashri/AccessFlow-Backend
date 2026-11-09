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
  },
  { timestamps: true }
);

const User = mongoose.model('User', userSchema, 'users');

export default User;
