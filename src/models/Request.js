import mongoose from 'mongoose';
import { REQUEST_PRIORITIES, REQUEST_STATUSES } from '../config/constants.js';

const requestSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
    },
    requesterId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    requestNumber: {
      type: String,
      required: true,
      trim: true,
    },
    departmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Department',
      required: true,
    },
    requestType: {
      type: String,
      required: true,
    },
    requestTypeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'WorkflowDefinition',
      default: null,
    },
    requestTypeCode: {
      type: String,
      trim: true,
      default: null,
    },
    requestTypeName: {
      type: String,
      trim: true,
      default: null,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      minlength: 3,
      maxlength: 200,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: '',
    },
    priority: {
      type: String,
      enum: REQUEST_PRIORITIES,
      default: 'MEDIUM',
    },
    details: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    attachments: {
      type: [{
        _id: false,
        filename: { type: String, required: true, trim: true, maxlength: 255 },
        mimeType: { type: String, required: true, trim: true, maxlength: 100 },
        size: { type: Number, required: true, min: 0 },
        storageKey: { type: String, required: true, trim: true, maxlength: 500 },
        checksum: { type: String, trim: true, maxlength: 200, default: null },
        uploadedAt: { type: Date, default: Date.now },
      }],
      default: [],
    },
    amount: {
      type: Number,
      default: null,
      min: 0,
    },
    status: {
      type: String,
      enum: REQUEST_STATUSES,
      default: 'DRAFT',
    },
    workflowDefinitionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'WorkflowDefinition',
      default: null,
    },
    currentSequence: {
      type: Number,
      default: 0,
      min: 0,
    },
    submittedAt: {
      type: Date,
      default: null,
    },
    cancelledAt: {
      type: Date,
      default: null,
    },
    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    cancellationReason: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: null,
    },
    returnedAt: {
      type: Date,
      default: null,
    },
    returnedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    returnReason: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: null,
    },
  },
  { timestamps: true }
);

requestSchema.index({ organizationId: 1, status: 1, createdAt: -1 });
requestSchema.index({ requesterId: 1, createdAt: -1 });
requestSchema.index({ organizationId: 1, requestNumber: 1 }, { unique: true });
requestSchema.index({ organizationId: 1, requesterId: 1, createdAt: -1 });
requestSchema.index({ organizationId: 1, departmentId: 1, createdAt: -1 });
requestSchema.index({ organizationId: 1, requestTypeId: 1, createdAt: -1 });

const Request = mongoose.model('Request', requestSchema, 'requests');

export default Request;
