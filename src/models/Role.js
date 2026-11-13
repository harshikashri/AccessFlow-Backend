import mongoose from 'mongoose';
import { PERMISSION_CATALOG, ROLE_TYPES } from '../config/constants.js';

const roleSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 200,
    },
    nameNormalized: {
      type: String,
      required: true,
      select: false,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: '',
    },
    roleType: {
      type: String,
      enum: ROLE_TYPES,
    },
    rolePurpose: {
      type: String,
      enum: ['GENERAL', 'FINANCE_APPROVER'],
      default: 'GENERAL',
    },
    permissions: {
      type: [String],
      default: [],
      validate: {
        validator(value) {
          if (!Array.isArray(value)) return false;
          return value.every((permission) => PERMISSION_CATALOG.includes(permission));
        },
        message: 'Each permission must be present in the application permission catalog.',
      },
    },
    status: {
      type: String,
      enum: ['ACTIVE', 'INACTIVE'],
      default: 'ACTIVE',
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  { timestamps: true }
);

roleSchema.set('autoIndex', false);

roleSchema.index({ organizationId: 1, name: 1 }, { unique: true });

roleSchema.pre('validate', function normalizeRoleName(next) {
  if (this.name !== undefined) {
    this.nameNormalized = this.name.trim().toLocaleLowerCase('en-US');
  }
  next();
});

const Role = mongoose.model('Role', roleSchema, 'roles');

export default Role;
