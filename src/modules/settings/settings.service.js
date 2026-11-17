import User from '../../models/User.js';
import Organization from '../../models/Organization.js';
import Session from '../../models/Session.js';
import AuditLog from '../../models/AuditLog.js';
import { AppError } from '../../utils/AppError.js';
import { withTransaction } from '../../utils/transaction.js';

const audit = async (session, { organizationId, actorId, action, changes = {} }) => {
  await AuditLog.create([{
    organizationId: organizationId || null,
    actorId,
    action,
    resourceType: 'User',
    resourceId: actorId,
    changes,
  }], { session });
};

const getUser = async (userId) => {
  const user = await User.findById(userId).select('name email accountStatus platformRole preferences organizationMemberships');
  if (!user || user.accountStatus !== 'ACTIVE') throw new AppError('User not found.', 404, 'USER_NOT_FOUND');
  return user;
};

const publicProfile = (user, organizationId) => ({
  id: String(user._id),
  name: user.name,
  email: user.email,
  accountStatus: user.accountStatus,
  platformRole: user.platformRole || null,
  organizationId: organizationId ? String(organizationId) : null,
});

export const getProfile = async ({ userId, organizationId }) => publicProfile(await getUser(userId), organizationId);

export const updateProfile = async ({ userId, organizationId, input }) => {
  const user = await getUser(userId);
  if (user.name === input.name) return publicProfile(user, organizationId);
  const previous = user.name;
  user.name = input.name;
  await withTransaction(async (session) => {
    await user.save({ session });
    await audit(session, { organizationId, actorId: userId, action: 'PROFILE_UPDATED', changes: { name: { from: previous, to: input.name } } });
  });
  return publicProfile(user, organizationId);
};

export const getPreferences = async ({ userId }) => {
  const user = await getUser(userId);
  return { ...user.preferences?.toObject?.() || user.preferences || {}, notifications: undefined };
};

export const updatePreferences = async ({ userId, organizationId, input }) => {
  const user = await getUser(userId);
  Object.assign(user.preferences, input);
  await withTransaction(async (session) => {
    await user.save({ session });
    await audit(session, { organizationId, actorId: userId, action: 'PREFERENCES_UPDATED', changes: input });
  });
  return { ...user.preferences.toObject(), notifications: undefined };
};

export const getNotificationPreferences = async ({ userId }) => {
  const user = await getUser(userId);
  return user.preferences?.notifications?.toObject?.() || user.preferences?.notifications || {};
};

export const updateNotificationPreferences = async ({ userId, organizationId, input }) => {
  const user = await getUser(userId);
  Object.assign(user.preferences.notifications, input);
  await withTransaction(async (session) => {
    await user.save({ session });
    await audit(session, { organizationId, actorId: userId, action: 'NOTIFICATION_PREFERENCES_UPDATED', changes: input });
  });
  return user.preferences.notifications.toObject();
};

export const listSessions = async ({ userId, sessionId }) => {
  const sessions = await Session.find({ userId }).select('_id organizationId createdAt expiresAt revokedAt lastUsedAt').sort({ createdAt: -1 }).lean();
  return sessions.map((session) => ({
    id: String(session._id),
    organizationId: session.organizationId ? String(session.organizationId) : null,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    revokedAt: session.revokedAt,
    lastUsedAt: session.lastUsedAt,
    current: String(session._id) === String(sessionId),
  }));
};

export const revokeSession = async ({ userId, organizationId, sessionId, targetSessionId }) => {
  const result = await Session.updateOne({ _id: targetSessionId, userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
  if (!result.matchedCount) throw new AppError('Session not found.', 404, 'SESSION_NOT_FOUND');
  await AuditLog.create([{
    organizationId: organizationId || null,
    actorId: userId,
    action: 'SESSION_REVOKED',
    resourceType: 'Session',
    resourceId: targetSessionId,
    changes: { current: String(sessionId) === String(targetSessionId) },
  }]);
  return { revoked: result.modifiedCount > 0 };
};

export const getOrganizationSettings = async ({ organizationId }) => {
  if (!organizationId) throw new AppError('An organization context is required.', 403, 'ORGANIZATION_CONTEXT_REQUIRED');
  const organization = await Organization.findById(organizationId).select('name status createdAt updatedAt').lean();
  if (!organization) throw new AppError('Organization not found.', 404, 'ORGANIZATION_NOT_FOUND');
  return {
    id: String(organization._id),
    name: organization.name,
    status: organization.status,
    createdAt: organization.createdAt,
    updatedAt: organization.updatedAt,
    editableThrough: 'organization-management',
  };
};
