import mongoose from 'mongoose';
import User from '../../models/User.js';
import Department from '../../models/Department.js';
import AuditLog from '../../models/AuditLog.js';
import { AppError } from '../../utils/AppError.js';
import { withTransaction } from '../../utils/transaction.js';
import { hasEffectivePermission, resolveEffectivePermissions } from '../../services/authorization/permission.service.js';

const activeMember = async ({ userId, organizationId, session }) => {
  let query = User.findOne({
    _id: userId,
    accountStatus: 'ACTIVE',
    organizationMemberships: { $elemMatch: { organizationId, status: 'ACTIVE' } },
  }).select('_id name email organizationMemberships approvalDelegations');
  if (session) query = query.session(session);
  const user = await query;
  if (!user) throw new AppError('An active organization member is required.', 403, 'NO_ORGANIZATION_MEMBERSHIP');
  return user;
};

const assertScope = async ({ organizationId, actorId, access, scopeType, departmentId, session }) => {
  if (scopeType === 'DEPARTMENT') {
    const department = await Department.findOne({ _id: departmentId, organizationId, status: 'ACTIVE' }).session(session);
    if (!department || !department.managerIds.some((id) => String(id) === String(actorId))) {
      throw new AppError('Delegation scope must be a department managed by the delegator.', 403, 'INVALID_DELEGATION_SCOPE');
    }
    if (!hasEffectivePermission(access, 'requests.approve', departmentId)) {
      throw new AppError('Permission requests.approve is required for this delegation scope.', 403, 'FORBIDDEN');
    }
  } else if (!hasEffectivePermission(access, 'requests.approve')) {
    throw new AppError('Permission requests.approve is required for delegation.', 403, 'FORBIDDEN');
  }
};

const assertDelegateEligibility = async ({ organizationId, delegateId, scopeType, departmentId }) => {
  const delegate = await activeMember({ userId: delegateId, organizationId });
  const access = await resolveEffectivePermissions({ userId: delegateId, organizationId });
  if (!hasEffectivePermission(access, 'requests.approve', scopeType === 'DEPARTMENT' ? departmentId : null)) {
    throw new AppError('The delegate is not eligible to approve in the selected scope.', 403, 'DELEGATE_NOT_ELIGIBLE');
  }
  return delegate;
};

const writeAudit = async (session, { organizationId, actorId, action, resourceId, changes }) => {
  await AuditLog.create([{ organizationId, actorId, action, resourceType: 'ApprovalDelegation', resourceId, changes }], { session });
};

const publicDelegation = (delegator, delegation) => ({
  id: String(delegation._id),
  organizationId: String(delegation.organizationId),
  delegatorId: String(delegator._id),
  delegateId: String(delegation.delegateId),
  scopeType: delegation.scopeType,
  departmentId: delegation.departmentId ? String(delegation.departmentId) : null,
  stageIds: delegation.stageIds,
  startsAt: delegation.startsAt,
  endsAt: delegation.endsAt,
  status: delegation.status,
  revokedAt: delegation.revokedAt,
  createdAt: delegation.createdAt,
  updatedAt: delegation.updatedAt,
});

export const createDelegation = async ({ organizationId, actorId, access, input }) => withTransaction(async (session) => {
  const delegator = await activeMember({ userId: actorId, organizationId, session });
  await assertScope({ organizationId, actorId, access, ...input, session });
  if (String(input.delegateId) === String(actorId)) throw new AppError('A user cannot delegate to themselves.', 400, 'INVALID_DELEGATION');
  const delegate = await assertDelegateEligibility({ organizationId, ...input });
  const conflict = delegator.approvalDelegations.some((item) =>
    item.status === 'ACTIVE' &&
    String(item.organizationId) === String(organizationId) &&
    new Date(item.startsAt) < input.endsAt &&
    new Date(item.endsAt) > input.startsAt &&
    (item.scopeType === 'ORGANIZATION' || input.scopeType === 'ORGANIZATION' || String(item.departmentId) === String(input.departmentId))
  );
  if (conflict) throw new AppError('An overlapping active delegation already exists.', 409, 'DELEGATION_CONFLICT');
  const delegation = {
    _id: new mongoose.Types.ObjectId(),
    organizationId,
    delegateId: delegate._id,
    ...input,
    status: 'ACTIVE',
  };
  delegator.approvalDelegations.push(delegation);
  await delegator.save({ session });
  await writeAudit(session, { organizationId, actorId, action: 'DELEGATION_CREATED', resourceId: delegation._id, changes: input });
  return publicDelegation(delegator, delegation);
});

export const listDelegations = async ({ organizationId, actorId }) => {
  const user = await activeMember({ userId: actorId, organizationId });
  return { items: user.approvalDelegations.filter((item) => String(item.organizationId) === String(organizationId)).map((item) => publicDelegation(user, item)) };
};

export const getDelegation = async ({ organizationId, actorId, delegationId }) => {
  const user = await activeMember({ userId: actorId, organizationId });
  const delegation = user.approvalDelegations.id(delegationId);
  if (!delegation || String(delegation.organizationId) !== String(organizationId)) throw new AppError('Delegation not found.', 404, 'DELEGATION_NOT_FOUND');
  return publicDelegation(user, delegation);
};

export const revokeDelegation = async ({ organizationId, actorId, delegationId }) => withTransaction(async (session) => {
  const user = await activeMember({ userId: actorId, organizationId, session });
  const delegation = user.approvalDelegations.id(delegationId);
  if (!delegation || String(delegation.organizationId) !== String(organizationId)) throw new AppError('Delegation not found.', 404, 'DELEGATION_NOT_FOUND');
  if (delegation.status === 'REVOKED') return publicDelegation(user, delegation);
  delegation.status = 'REVOKED';
  delegation.revokedAt = new Date();
  delegation.revokedBy = actorId;
  await user.save({ session });
  await writeAudit(session, { organizationId, actorId, action: 'DELEGATION_REVOKED', resourceId: delegation._id, changes: {} });
  return publicDelegation(user, delegation);
});

export const updateDelegation = async ({ organizationId, actorId, access, delegationId, input }) => withTransaction(async (session) => {
  const user = await activeMember({ userId: actorId, organizationId, session });
  const delegation = user.approvalDelegations.id(delegationId);
  if (!delegation || String(delegation.organizationId) !== String(organizationId)) throw new AppError('Delegation not found.', 404, 'DELEGATION_NOT_FOUND');
  if (delegation.status !== 'ACTIVE') throw new AppError('Revoked delegations cannot be updated.', 409, 'DELEGATION_REVOKED');
  await assertScope({ organizationId, actorId, access, ...input, session });
  await assertDelegateEligibility({ organizationId, ...input });
  if (String(input.delegateId) === String(actorId)) throw new AppError('A user cannot delegate to themselves.', 400, 'INVALID_DELEGATION');
  Object.assign(delegation, input);
  await user.save({ session });
  await writeAudit(session, { organizationId, actorId, action: 'DELEGATION_UPDATED', resourceId: delegation._id, changes: input });
  return publicDelegation(user, delegation);
});

export const activeDelegationFor = async ({ organizationId, delegatorId, delegateId, departmentId, stageId, now = new Date() }) => {
  const user = await User.findOne({
    _id: delegatorId,
    accountStatus: 'ACTIVE',
    organizationMemberships: { $elemMatch: { organizationId, status: 'ACTIVE' } },
    approvalDelegations: {
      $elemMatch: {
        organizationId,
        delegateId,
        status: 'ACTIVE',
        startsAt: { $lte: now },
        endsAt: { $gt: now },
        $or: [
          { scopeType: 'ORGANIZATION' },
          { scopeType: 'DEPARTMENT', departmentId },
        ],
        $and: [{ $or: [{ stageIds: { $size: 0 } }, { stageIds: stageId }] }],
      },
    },
  }).select('approvalDelegations');
  return user?.approvalDelegations.find((item) =>
    String(item.delegateId) === String(delegateId) &&
    item.status === 'ACTIVE' &&
    item.startsAt <= now &&
    item.endsAt > now &&
    (item.scopeType === 'ORGANIZATION' || String(item.departmentId) === String(departmentId)) &&
    (!item.stageIds.length || item.stageIds.includes(stageId))
  ) || null;
};
