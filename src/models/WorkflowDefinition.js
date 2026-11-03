import mongoose from 'mongoose';
import { CONDITIONAL_OPERATORS, REQUEST_TYPES } from '../config/constants.js';

const workflowStageConditionSchema = new mongoose.Schema(
  {
    field: {
      type: String,
      required: true,
      trim: true,
    },
    operator: {
      type: String,
      enum: CONDITIONAL_OPERATORS,
      required: true,
    },
    value: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
  },
  { _id: false }
);

const workflowStageSchema = new mongoose.Schema(
  {
    sequence: {
      type: Number,
      required: true,
      min: 1,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    approverType: {
      type: String,
      enum: ['DEPARTMENT_MANAGER', 'ROLE', 'USER'],
      required: true,
    },
    roleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Role',
      default: null,
    },
    condition: {
      type: workflowStageConditionSchema,
      default: null,
    },
  },
  { _id: false }
);

const workflowDefinitionSchema = new mongoose.Schema(
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
    requestType: {
      type: String,
      enum: REQUEST_TYPES,
      required: true,
    },
    version: {
      type: Number,
      required: true,
      min: 1,
      default: 1,
    },
    stages: {
      type: [workflowStageSchema],
      required: true,
      validate: {
        validator(value) {
          return Array.isArray(value) && value.length > 0;
        },
        message: 'At least one workflow stage is required.',
      },
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  { timestamps: true }
);

workflowDefinitionSchema.index({ organizationId: 1, requestType: 1, isActive: 1 });
workflowDefinitionSchema.index({ organizationId: 1, name: 1, version: 1 }, { unique: true });

const WorkflowDefinition = mongoose.model('WorkflowDefinition', workflowDefinitionSchema, 'workflowDefinitions');

export default WorkflowDefinition;
