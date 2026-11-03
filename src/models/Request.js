import mongoose from 'mongoose';
import { REQUEST_TYPES, REQUEST_STATUSES } from '../config/constants.js';

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
    departmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Department',
      required: true,
    },
    requestType: {
      type: String,
      enum: REQUEST_TYPES,
      required: true,
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
  },
  { timestamps: true }
);

requestSchema.index({ organizationId: 1, status: 1, createdAt: -1 });
requestSchema.index({ requesterId: 1, createdAt: -1 });

requestSchema.pre('validate', function validateRequest(next) {
  if (this.requestType === 'PURCHASE') {
    if (this.amount === null || this.amount <= 0) {
      this.invalidate('amount', 'amount is required and must be positive for PURCHASE requests.');
    }
  }
  next();
});

const Request = mongoose.model('Request', requestSchema, 'requests');

export default Request;
