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
    workflowDefinitionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'WorkflowDefinition',
      required: true,
    },
    workflowVersion: {
      type: Number,
      required: true,
      min: 1,
    },
    stageId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
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
    assignmentResolution: {
      type: String,
      enum: ['DIRECT', 'CLAIM_ONE'],
      default: 'DIRECT',
    },
    approvalMode: {
      type: String,
      enum: ['ANY', 'ALL'],
      default: 'ANY',
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
    claimedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    claimedAt: {
      type: Date,
      default: null,
    },
    decidedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
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
    returnedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    returnedAt: {
      type: Date,
      default: null,
    },
    slaStartedAt: { type: Date, default: null },
    slaDueAt: { type: Date, default: null },
    isOverdue: { type: Boolean, default: false },
    lastReminderAt: { type: Date, default: null },
    nextReminderAt: { type: Date, default: null },
    reminderCount: { type: Number, default: 0, min: 0 },
    escalationLevel: { type: Number, default: 0, min: 0 },
    lastEscalatedAt: { type: Date, default: null },
    claimExpiresAt: { type: Date, default: null },
    actedOnBehalfOf: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    delegationId: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

approvalStepSchema.index({ requestId: 1, attemptNumber: 1, sequence: 1, approverId: 1 }, { unique: true });
approvalStepSchema.index({ organizationId: 1, approverId: 1, status: 1 });
approvalStepSchema.index({ organizationId: 1, decidedBy: 1, decisionAt: -1 });
approvalStepSchema.index({ organizationId: 1, status: 1, slaDueAt: 1 });
approvalStepSchema.index({ organizationId: 1, status: 1, claimExpiresAt: 1 });
approvalStepSchema.index({ status: 1, claimExpiresAt: 1 });
approvalStepSchema.index({ status: 1, nextReminderAt: 1 });
approvalStepSchema.index({ status: 1, isOverdue: 1, slaDueAt: 1 });
approvalStepSchema.index({ organizationId: 1, requestId: 1, attemptNumber: 1, sequence: 1, status: 1, claimedBy: 1 });

const ApprovalStep = mongoose.model('ApprovalStep', approvalStepSchema, 'approvalSteps');

export default ApprovalStep;
