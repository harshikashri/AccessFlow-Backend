import crypto from 'crypto';
import User from '../../models/User.js';
import Organization from '../../models/Organization.js';
import Session from '../../models/Session.js';
import AuditLog from '../../models/AuditLog.js';
import { AppError } from '../../utils/AppError.js';
import { hashPassword } from '../../utils/password.js';
import { hashToken } from '../../utils/token.js';
import { withTransaction } from '../../utils/transaction.js';
import { env } from '../../config/env.js';
import { assertEmailConfiguration, sendEmail } from '../../services/email/email.service.js';
import {
  accountSetupEmail,
  firstTimeSetupEmail,
  passwordResetEmail,
} from '../../services/email/email.templates.js';
import { USER_ACTIONS, USER_RESET_TOKEN_TTL_MS, USER_SETUP_TOKEN_TTL_MS } from '../users/user.constants.js';

const writeAuditLog = async (session, { organizationId, actorId, action, resourceId, changes = {} }) => {
  await AuditLog.create(
    [{
      organizationId: organizationId || null,
      actorId,
      action,
      resourceType: 'User',
      resourceId,
      changes,
      timestamp: new Date(),
    }],
    { session }
  );
};

const createRawToken = () => crypto.randomBytes(32).toString('base64url');

const getSetupUrl = (token) => {
  const url = new URL('/set-password', env.CLIENT_URL);
  url.searchParams.set('token', token);
  return url.toString();
};

const getResetUrl = (token) => {
  const url = new URL('/reset-password', env.CLIENT_URL);
  url.searchParams.set('token', token);
  return url.toString();
};

const getOrganizationName = async (organizationId, session) => {
  if (!organizationId) return 'AccessFlow';
  const query = Organization.findById(organizationId).select('name status');
  if (session) query.session(session);
  const organization = await query;
  if (!organization) throw new AppError('Organization not found.', 404, 'ORGANIZATION_NOT_FOUND');
  if (organization.status !== 'ACTIVE') {
    throw new AppError('This organization is inactive.', 403, 'ORGANIZATION_INACTIVE');
  }
  return organization.name;
};

const sendSetupEmail = async ({ user, organizationName, token, initial = false }) => {
  const templateFactory = initial ? accountSetupEmail : firstTimeSetupEmail;
  const template = templateFactory({
    name: user.name,
    email: user.email,
    organizationName,
    link: getSetupUrl(token),
    expiryMinutes: 30,
  });
  return sendEmail({ to: user.email, ...template });
};

export const sendInitialSetupInstructions = async ({ user, organizationName, token }) =>
  sendSetupEmail({ user, organizationName, token, initial: true });

const sendResetEmail = async ({ user, organizationName, token }) => {
  const template = passwordResetEmail({
    name: user.name,
    email: user.email,
    organizationName,
    link: getResetUrl(token),
    expiryMinutes: 30,
  });
  return sendEmail({ to: user.email, ...template });
};

const emailFailure = (userId, code) =>
  new AppError(
    'The account change was saved, but the email could not be delivered. An administrator can safely retry the message.',
    502,
    code,
    { userId: String(userId) }
  );

export const issueAccountSetupToken = async ({
  userId,
  organizationId,
  actorId,
  initial = false,
  action = USER_ACTIONS.ADMIN_PASSWORD_RESET_REQUESTED,
}) => {
  const rawToken = createRawToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + USER_SETUP_TOKEN_TTL_MS);
  const issued = await withTransaction(async (session) => {
    const user = await User.findOne({
      _id: userId,
      accountStatus: 'INACTIVE',
      passwordSetupRequired: true,
      organizationMemberships: {
        $elemMatch: { organizationId, status: 'ACTIVE' },
      },
    }).session(session);
    if (!user) throw new AppError('Pending setup user not found.', 404, 'USER_NOT_FOUND');

    const organizationName = await getOrganizationName(organizationId, session);
    user.passwordSetupTokenHash = tokenHash;
    user.passwordSetupTokenExpiresAt = expiresAt;
    user.passwordResetTokenHash = undefined;
    user.passwordResetTokenExpiresAt = undefined;
    await user.save({ session });

    if (!initial) {
      await writeAuditLog(session, {
        organizationId,
        actorId,
        action,
        resourceId: user._id,
      });
    }

    return { user: { id: String(user._id), name: user.name, email: user.email }, organizationName };
  });

  try {
    await sendSetupEmail({ user: issued.user, organizationName: issued.organizationName, token: rawToken, initial });
  } catch {
    throw emailFailure(userId, initial ? 'USER_CREATED_EMAIL_FAILED' : 'ADMIN_SETUP_EMAIL_FAILED');
  }
  return { sent: true };
};

export const issuePasswordResetToken = async ({ userId, organizationId, actorId, action = USER_ACTIONS.ADMIN_PASSWORD_RESET_REQUESTED }) => {
  const rawToken = createRawToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + USER_RESET_TOKEN_TTL_MS);
  const issued = await withTransaction(async (session) => {
    const userFilter = {
      _id: userId,
      accountStatus: 'ACTIVE',
      passwordSetupRequired: { $ne: true },
    };
    if (organizationId) {
      userFilter.organizationMemberships = {
        $elemMatch: { organizationId, status: 'ACTIVE' },
      };
    } else {
      userFilter.platformRole = 'SUPER_ADMIN';
    }
    const user = await User.findOne(userFilter).session(session);
    if (!user) throw new AppError('Active user not found.', 404, 'USER_NOT_FOUND');

    const organizationName = await getOrganizationName(organizationId, session);
    user.passwordResetTokenHash = tokenHash;
    user.passwordResetTokenExpiresAt = expiresAt;
    user.passwordSetupTokenHash = undefined;
    user.passwordSetupTokenExpiresAt = undefined;
    await user.save({ session });
    await writeAuditLog(session, {
      organizationId,
      actorId: actorId || user._id,
      action,
      resourceId: user._id,
    });
    return { user: { id: String(user._id), name: user.name, email: user.email }, organizationName };
  });

  try {
    await sendResetEmail({ user: issued.user, organizationName: issued.organizationName, token: rawToken });
  } catch {
    throw emailFailure(userId, 'PASSWORD_RESET_EMAIL_FAILED');
  }
  return { sent: true };
};

export const completeInitialPasswordSetup = async ({ token, password }) => {
  const tokenHash = hashToken(token);
  const passwordHash = await hashPassword(password);
  return withTransaction(async (session) => {
    const user = await User.findOne({
      passwordSetupTokenHash: tokenHash,
      passwordSetupTokenExpiresAt: { $gt: new Date() },
      passwordSetupRequired: true,
      accountStatus: 'INACTIVE',
    }).select('+passwordSetupTokenHash +passwordSetupTokenExpiresAt').session(session);
    if (!user) throw new AppError('Password setup token is invalid or expired.', 400, 'INVALID_SETUP_TOKEN');

    const membership = user.organizationMemberships.find((item) => item.status === 'ACTIVE');
    if (!membership) throw new AppError('An active organization membership is required.', 403, 'NO_ORGANIZATION_MEMBERSHIP');
    await getOrganizationName(membership.organizationId, session);

    user.passwordHash = passwordHash;
    user.passwordSetupRequired = false;
    user.accountStatus = 'ACTIVE';
    user.passwordSetupTokenHash = undefined;
    user.passwordSetupTokenExpiresAt = undefined;
    await user.save({ session });
    await writeAuditLog(session, {
      organizationId: membership.organizationId,
      actorId: user._id,
      action: USER_ACTIONS.PASSWORD_SETUP_COMPLETED,
      resourceId: user._id,
      changes: { passwordSetupRequired: { from: true, to: false }, accountStatus: { from: 'INACTIVE', to: 'ACTIVE' } },
    });
    return { userId: String(user._id) };
  });
};

export const requestForgotPassword = async (email) => {
  assertEmailConfiguration();
  const user = await User.findOne({ email });
  if (!user) return { accepted: true };

  const activeMembership = user.organizationMemberships.find((membership) => membership.status === 'ACTIVE');
  const organizationId = activeMembership?.organizationId || null;

  if (user.passwordSetupRequired && user.accountStatus === 'INACTIVE' && activeMembership) {
    try {
      await issueAccountSetupToken({
        userId: user._id,
        organizationId,
        actorId: user._id,
        initial: false,
        action: USER_ACTIONS.PASSWORD_RESET_REQUESTED,
      });
    } catch {
      console.error('Password setup email delivery failed for user id:', String(user._id));
    }
    return { accepted: true };
  }
  if (user.accountStatus !== 'ACTIVE' || !user.passwordSetupRequired && !activeMembership && !user.platformRole) {
    return { accepted: true };
  }

  try {
    await issuePasswordResetToken({
      userId: user._id,
      organizationId,
      actorId: user._id,
      action: USER_ACTIONS.PASSWORD_RESET_REQUESTED,
    });
  } catch {
    console.error('Password reset email delivery failed for user id:', String(user._id));
  }
  return { accepted: true };
};

export const completePasswordReset = async ({ token, password }) => {
  const tokenHash = hashToken(token);
  const passwordHash = await hashPassword(password);
  return withTransaction(async (session) => {
    const user = await User.findOne({
      passwordResetTokenHash: tokenHash,
      passwordResetTokenExpiresAt: { $gt: new Date() },
      passwordSetupRequired: { $ne: true },
      accountStatus: 'ACTIVE',
    }).select('+passwordResetTokenHash +passwordResetTokenExpiresAt').session(session);
    if (!user) throw new AppError('Password reset token is invalid or expired.', 400, 'INVALID_RESET_TOKEN');

    user.passwordHash = passwordHash;
    user.passwordResetTokenHash = undefined;
    user.passwordResetTokenExpiresAt = undefined;
    await user.save({ session });
    await Session.updateMany(
      { userId: user._id, revokedAt: null },
      { $set: { revokedAt: new Date() } },
      { session }
    );
    await writeAuditLog(session, {
      organizationId: null,
      actorId: user._id,
      action: USER_ACTIONS.PASSWORD_RESET_COMPLETED,
      resourceId: user._id,
      changes: { passwordChanged: true, sessionsRevoked: true },
    });
    return { userId: String(user._id) };
  });
};

export default {
  issueAccountSetupToken,
  sendInitialSetupInstructions,
  issuePasswordResetToken,
  completeInitialPasswordSetup,
  requestForgotPassword,
  completePasswordReset,
};
