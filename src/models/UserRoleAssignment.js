import mongoose from 'mongoose';

const userRoleAssignmentSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    roleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Role',
      required: true,
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
    scopeType: {
      type: String,
      enum: ['ORGANIZATION', 'DEPARTMENT'],
      required: true,
    },
    status: {
      type: String,
      enum: ['ACTIVE', 'INACTIVE'],
      default: 'ACTIVE',
    },
    assignedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    assignedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: false }
);

userRoleAssignmentSchema.index({ userId: 1, roleId: 1, organizationId: 1, departmentId: 1 });
userRoleAssignmentSchema.index({ organizationId: 1, departmentId: 1, scopeType: 1 });

userRoleAssignmentSchema.pre('validate', function validateScope(next) {
  if (this.scopeType === 'ORGANIZATION' && this.departmentId !== null) {
    this.invalidate('departmentId', 'departmentId must be null for organization-wide assignments.');
  }
  if (this.scopeType === 'DEPARTMENT' && !this.departmentId) {
    this.invalidate('departmentId', 'departmentId is required for department-scoped assignments.');
  }
  next();
});

const UserRoleAssignment = mongoose.model('UserRoleAssignment', userRoleAssignmentSchema, 'userRoleAssignments');

export default UserRoleAssignment;
