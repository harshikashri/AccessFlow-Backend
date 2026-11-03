import mongoose from 'mongoose';
import { APPROVER_TYPES, APPROVAL_STATUSES } from '../config/constants.js';

const approvalStepSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
    },
    requestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Request',
      required: true,
    },
    attemptNumber: {
      type: Number,
      required: true,
      min: 1,
    },
    sequence: {
      type: Number,
      required: true,
      min: 1,
    },
    stageName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    approverType: {
      type: String,
      enum: APPROVER_TYPES,
      required: true,
    },
    approverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    roleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Role',
      default: null,
    },
    status: {
      type: String,
      enum: APPROVAL_STATUSES,
      default: 'PENDING',
    },
    comments: {
      type: String,
      maxlength: 2000,
      default: '',
    },
    decisionAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

approvalStepSchema.index({ requestId: 1, attemptNumber: 1, sequence: 1 }, { unique: true });
approvalStepSchema.index({ organizationId: 1, approverId: 1, status: 1 });

const ApprovalStep = mongoose.model('ApprovalStep', approvalStepSchema, 'approvalSteps');

export default ApprovalStep;
