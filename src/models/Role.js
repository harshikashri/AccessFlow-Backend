import mongoose from 'mongoose';
import { PERMISSION_CATALOG } from '../config/constants.js';

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
    description: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: '',
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

roleSchema.index({ organizationId: 1, name: 1 }, { unique: true });

const Role = mongoose.model('Role', roleSchema, 'roles');

export default Role;
