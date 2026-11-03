import User from '../../models/User.js';
import Session from '../../models/Session.js';
import Organization from '../../models/Organization.js';
import { AppError } from '../../utils/AppError.js';
import { verifyPassword } from '../../utils/password.js';
import {
  generateAccessToken,
  generateRefreshToken,
  getRefreshTokenExpiryMs,
  hashToken,
} from '../../utils/token.js';
import {
  findActiveMembership,
  getActiveMemberships,
  isSuperAdmin,
  toObjectIdOrNull,
  toPublicUser,
} from './auth.utils.js';

const invalidCredentials = () =>
  new AppError('Invalid email or password.', 401, 'INVALID_CREDENTIALS');

const resolveOrganizationContext = (user, requestedOrganizationId) => {
  if (isSuperAdmin(user)) {
    return null;
  }

  const activeMemberships = getActiveMemberships(user);
  if (activeMemberships.length === 0) {
    throw new AppError(
      'No active organization membership found for this account.',
      403,
      'NO_ORGANIZATION_MEMBERSHIP'
    );
  }

  if (requestedOrganizationId) {
    const membership = findActiveMembership(user, requestedOrganizationId);
    if (!membership) {
      throw new AppError(
        'You do not have access to the requested organization.',
        403,
        'INVALID_ORGANIZATION_CONTEXT'
      );
    }
    return membership.organizationId;
  }

  if (activeMemberships.length === 1) {
    return activeMemberships[0].organizationId;
  }

  throw new AppError(
    'organizationId is required when the account belongs to multiple organizations.',
    400,
    'ORGANIZATION_SELECTION_REQUIRED',
    {
      organizations: activeMemberships.map((membership) => String(membership.organizationId)),
    }
  );
};

const assertUserActive = (user) => {
  if (!user || user.accountStatus !== 'ACTIVE') {
    throw new AppError('Account is inactive.', 403, 'ACCOUNT_INACTIVE');
  }
};

const assertSessionActive = (session) => {
  if (!session) {
    throw new AppError('Session not found.', 401, 'SESSION_NOT_FOUND');
  }
  if (session.revokedAt) {
    throw new AppError('Session has been revoked.', 401, 'SESSION_REVOKED');
  }
  if (session.expiresAt.getTime() <= Date.now()) {
    throw new AppError('Session has expired.', 401, 'SESSION_EXPIRED');
  }
};

const assertOrganizationContextForUser = async (user, organizationId) => {
  if (isSuperAdmin(user)) {
    if (organizationId) {
      throw new AppError(
        'Super Admin platform sessions must not include an organization context.',
        401,
        'INVALID_ORGANIZATION_CONTEXT'
      );
    }
    return;
  }

  if (!organizationId) {
    throw new AppError('Organization context is required.', 401, 'INVALID_ORGANIZATION_CONTEXT');
  }

  const membership = findActiveMembership(user, organizationId);
  if (!membership) {
    throw new AppError(
      'Active organization membership is required for this session.',
      401,
      'INVALID_ORGANIZATION_CONTEXT'
    );
  }

  const organization = await Organization.findById(organizationId).select('status');
  if (!organization) {
    throw new AppError('Organization context is invalid.', 401, 'INVALID_ORGANIZATION_CONTEXT');
  }
  if (organization.status !== 'ACTIVE') {
    throw new AppError(
      'This organization is inactive.',
      403,
      'ORGANIZATION_INACTIVE'
    );
  }
};

const buildAuthResult = (user, session, refreshToken) => {
  const accessToken = generateAccessToken({
    userId: user._id,
    sessionId: session._id,
    organizationId: session.organizationId,
    platformRole: user.platformRole,
  });

  return {
    accessToken,
    refreshToken,
    user: toPublicUser(user, session.organizationId),
    session,
  };
};

export const login = async ({ email, password, organizationId }) => {
  const user = await User.findOne({ email });
  if (!user) {
    throw invalidCredentials();
  }

  const passwordMatches = await verifyPassword(password, user.passwordHash);
  if (!passwordMatches) {
    throw invalidCredentials();
  }

  assertUserActive(user);

  const resolvedOrganizationId = resolveOrganizationContext(user, organizationId);
  await assertOrganizationContextForUser(user, resolvedOrganizationId);

  const refreshToken = generateRefreshToken();
  const refreshTokenHash = hashToken(refreshToken);
  const expiresAt = new Date(Date.now() + getRefreshTokenExpiryMs());

  const session = await Session.create({
    userId: user._id,
    organizationId: toObjectIdOrNull(resolvedOrganizationId),
    refreshTokenHash,
    expiresAt,
    revokedAt: null,
    lastUsedAt: new Date(),
  });

  return buildAuthResult(user, session, refreshToken);
};

export const refresh = async (rawRefreshToken) => {
  if (!rawRefreshToken) {
    throw new AppError('Refresh token is required.', 401, 'REFRESH_TOKEN_MISSING');
  }

  const presentedHash = hashToken(rawRefreshToken);
  const existingSession = await Session.findOne({ refreshTokenHash: presentedHash });

  if (!existingSession) {
    // Suspected reuse or unknown token: reject without blindly wiping other sessions.
    // Concurrent refresh of a legitimate session is handled by the atomic rotate below.
    throw new AppError('Invalid refresh token.', 401, 'INVALID_REFRESH_TOKEN');
  }

  assertSessionActive(existingSession);

  const user = await User.findById(existingSession.userId);
  if (!user) {
    await Session.updateOne(
      { _id: existingSession._id, revokedAt: null },
      { $set: { revokedAt: new Date() } }
    );
    throw new AppError('User associated with this session no longer exists.', 401, 'USER_NOT_FOUND');
  }

  if (user.accountStatus !== 'ACTIVE') {
    await Session.updateOne(
      { _id: existingSession._id, revokedAt: null },
      { $set: { revokedAt: new Date() } }
    );
    throw new AppError('Account is inactive.', 403, 'ACCOUNT_INACTIVE');
  }

  await assertOrganizationContextForUser(user, existingSession.organizationId);

  const nextRefreshToken = generateRefreshToken();
  const nextRefreshTokenHash = hashToken(nextRefreshToken);
  const now = new Date();

  // Atomic conditional update: only the first concurrent request with this hash succeeds.
  const rotatedSession = await Session.findOneAndUpdate(
    {
      _id: existingSession._id,
      refreshTokenHash: presentedHash,
      revokedAt: null,
      expiresAt: { $gt: now },
    },
    {
      $set: {
        refreshTokenHash: nextRefreshTokenHash,
        lastUsedAt: now,
      },
    },
    { new: true }
  );

  if (!rotatedSession) {
    // Another concurrent refresh likely won the race. Do not revoke the winner's session.
    throw new AppError(
      'Refresh token is no longer valid.',
      401,
      'REFRESH_TOKEN_REUSED_OR_CONSUMED'
    );
  }

  return buildAuthResult(user, rotatedSession, nextRefreshToken);
};

export const logout = async ({ userId, sessionId }) => {
  if (!userId || !sessionId) {
    return { revoked: false };
  }

  const result = await Session.updateOne(
    {
      _id: sessionId,
      userId,
      revokedAt: null,
    },
    {
      $set: {
        revokedAt: new Date(),
      },
    }
  );

  return { revoked: result.modifiedCount > 0 };
};

export const logoutAll = async (userId) => {
  const result = await Session.updateMany(
    {
      userId,
      revokedAt: null,
    },
    {
      $set: {
        revokedAt: new Date(),
      },
    }
  );

  return { revokedCount: result.modifiedCount };
};

export const getCurrentUser = async ({ userId, sessionId }) => {
  const user = await User.findById(userId);
  if (!user) {
    throw new AppError('User not found.', 401, 'USER_NOT_FOUND');
  }
  assertUserActive(user);

  const session = await Session.findById(sessionId);
  assertSessionActive(session);

  if (String(session.userId) !== String(user._id)) {
    throw new AppError('Session does not belong to this user.', 401, 'SESSION_MISMATCH');
  }

  await assertOrganizationContextForUser(user, session.organizationId);

  return {
    user: toPublicUser(user, session.organizationId),
  };
};

export const loadAuthContext = async ({ userId, sessionId, organizationId, platformRole }) => {
  const user = await User.findById(userId);
  if (!user) {
    throw new AppError('User not found.', 401, 'USER_NOT_FOUND');
  }
  assertUserActive(user);

  const session = await Session.findById(sessionId);
  assertSessionActive(session);

  if (String(session.userId) !== String(user._id)) {
    throw new AppError('Session does not belong to this user.', 401, 'SESSION_MISMATCH');
  }

  if (String(session.organizationId || '') !== String(organizationId || '')) {
    throw new AppError('Token organization context is invalid.', 401, 'INVALID_ORGANIZATION_CONTEXT');
  }

  if ((user.platformRole || null) !== (platformRole || null)) {
    throw new AppError('Token platform role is invalid.', 401, 'INVALID_PLATFORM_ROLE');
  }

  await assertOrganizationContextForUser(user, session.organizationId);

  return {
    user,
    session,
    auth: {
      userId: String(user._id),
      sessionId: String(session._id),
      organizationId: session.organizationId ? String(session.organizationId) : null,
      platformRole: user.platformRole || null,
    },
  };
};

export default {
  login,
  refresh,
  logout,
  logoutAll,
  getCurrentUser,
  loadAuthContext,
};
