import mongoose from 'mongoose';
import { CONDITIONAL_OPERATORS, REQUEST_DEFINITION_TYPES, REQUEST_FIELD_TYPES, REQUEST_TYPES } from '../config/constants.js';

const requestTypeFieldSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true, maxlength: 100 },
    label: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 1000, default: '' },
    visibleWhen: { type: mongoose.Schema.Types.Mixed, default: null },
    requiredWhen: { type: mongoose.Schema.Types.Mixed, default: null },
    type: { type: String, enum: REQUEST_FIELD_TYPES, required: true },
    semantic: { type: String, enum: ['AMOUNT'], default: null },
    required: { type: Boolean, default: false },
    placeholder: { type: String, trim: true, maxlength: 500, default: '' },
    options: { type: [String], default: undefined },
    validation: { type: mongoose.Schema.Types.Mixed, default: {} },
    displayOrder: { type: Number, min: 0, default: 0 },
  },
  { _id: false }
);

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
    stageId: {
      type: String,
      trim: true,
      maxlength: 100,
    },
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
    description: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: '',
    },
    approverType: {
      type: String,
      enum: ['DEPARTMENT_MANAGER', 'ROLE', 'USER', 'ORGANIZATION_ADMIN'],
      required: true,
    },
    assignment: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    approvalMode: {
      type: String,
      enum: ['ANY', 'ALL'],
      default: 'ANY',
    },
    isMandatory: {
      type: Boolean,
      default: false,
    },
    isConfigurable: {
      type: Boolean,
      default: true,
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
    sla: {
      duration: { type: Number, min: 1, default: null },
      unit: { type: String, enum: ['MINUTES', 'HOURS', 'DAYS'], default: 'HOURS' },
      reminders: [{
        after: { type: Number, min: 1 },
        unit: { type: String, enum: ['MINUTES', 'HOURS', 'DAYS'] },
      }],
      escalation: {
        enabled: { type: Boolean, default: false },
        after: { type: Number, min: 1, default: null },
        unit: { type: String, enum: ['MINUTES', 'HOURS', 'DAYS'], default: 'HOURS' },
        targetType: { type: String, enum: ['USER', 'ROLE'], default: null },
        targetId: { type: mongoose.Schema.Types.ObjectId, default: null },
        levels: [{
          after: { type: Number, min: 1, required: true },
          unit: { type: String, enum: ['MINUTES', 'HOURS', 'DAYS'], default: 'HOURS' },
          targetType: { type: String, enum: ['USER', 'ROLE'], required: true },
          targetId: { type: mongoose.Schema.Types.ObjectId, required: true },
        }],
      },
      claimExpiry: {
        duration: { type: Number, min: 1, default: null },
        unit: { type: String, enum: ['MINUTES', 'HOURS', 'DAYS'], default: 'HOURS' },
      },
    },
  },
  { _id: false }
);

const workflowDefinitionSchema = new mongoose.Schema(
  {
    definitionType: {
      type: String,
      enum: REQUEST_DEFINITION_TYPES,
      default: 'APPROVAL_WORKFLOW',
    },
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
      default: null,
    },
    requestTypeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'WorkflowDefinition',
      default: null,
    },
    code: {
      type: String,
      trim: true,
      default: null,
    },
    codeNormalized: {
      type: String,
      trim: true,
      default: null,
      select: false,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: '',
    },
    fields: {
      type: [requestTypeFieldSchema],
      default: [],
    },
    isDefault: {
      type: Boolean,
      default: false,
    },
    version: {
      type: Number,
      required: true,
      min: 1,
      default: 1,
    },
    stages: {
      type: [workflowStageSchema],
      default: [],
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
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

workflowDefinitionSchema.index({ organizationId: 1, requestType: 1, isActive: 1 });
workflowDefinitionSchema.index({ organizationId: 1, name: 1, version: 1 }, { unique: true });
workflowDefinitionSchema.index(
  { organizationId: 1, requestTypeId: 1, version: 1 },
  { unique: true, partialFilterExpression: { definitionType: 'APPROVAL_WORKFLOW', requestTypeId: { $type: 'objectId' } } }
);
workflowDefinitionSchema.index(
  { organizationId: 1, requestTypeId: 1 },
  { unique: true, partialFilterExpression: { definitionType: 'APPROVAL_WORKFLOW', requestTypeId: { $type: 'objectId' }, isActive: true } }
);
workflowDefinitionSchema.index(
  { organizationId: 1, isDefault: 1 },
  { unique: true, partialFilterExpression: { definitionType: 'APPROVAL_WORKFLOW', isDefault: true, isActive: true } }
);
workflowDefinitionSchema.index(
  { organizationId: 1, codeNormalized: 1 },
  { unique: true, partialFilterExpression: { definitionType: 'REQUEST_TYPE', codeNormalized: { $type: 'string' } } }
);

workflowDefinitionSchema.pre('validate', function validateDefinition(next) {
  if (this.definitionType === 'REQUEST_TYPE') {
    if (!this.code) this.invalidate('code', 'Request type code is required.');
    if (!this.fields?.length) this.invalidate('fields', 'At least one request type field is required.');
    if (this.stages?.length) this.invalidate('stages', 'Request type records cannot define approval stages.');
  } else if (!this.stages?.length) {
    this.invalidate('stages', 'At least one workflow stage is required.');
  } else if (this.definitionType === 'APPROVAL_WORKFLOW' && this.requestTypeId && this.requestTypeId.equals(this._id)) {
    this.invalidate('requestTypeId', 'A workflow cannot target itself.');
  }
  if (this.code !== undefined && this.code !== null) {
    this.codeNormalized = this.code.trim().toLocaleLowerCase('en-US');
  }
  next();
});

const WorkflowDefinition = mongoose.model('WorkflowDefinition', workflowDefinitionSchema, 'workflowDefinitions');

export default WorkflowDefinition;
