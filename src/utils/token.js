import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { AppError } from './AppError.js';

const REFRESH_TOKEN_BYTES = 48;

const parseDurationToMs = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    throw new AppError('Invalid duration configuration.', 500, 'CONFIG_ERROR');
  }

  const trimmed = value.trim().toLowerCase();
  const match = trimmed.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!match) {
    throw new AppError(`Unsupported duration format: ${value}`, 500, 'CONFIG_ERROR');
  }

  const amount = Number(match[1]);
  const unit = match[2];
  const multipliers = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return amount * multipliers[unit];
};

export const getRefreshTokenExpiryMs = () => parseDurationToMs(env.REFRESH_TOKEN_EXPIRY);

export const getAccessTokenExpiry = () => env.ACCESS_TOKEN_EXPIRY;

export const hashToken = (token) =>
  crypto.createHash('sha256').update(token).digest('hex');

export const generateRefreshToken = () =>
  crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');

export const generateAccessToken = ({ userId, sessionId, organizationId, platformRole }) => {
  const payload = {
    userId: String(userId),
    sessionId: String(sessionId),
    organizationId: organizationId ? String(organizationId) : null,
    platformRole: platformRole || null,
  };

  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.ACCESS_TOKEN_EXPIRY,
  });
};

export const verifyAccessToken = (token) => {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET);
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      throw new AppError('Access token has expired.', 401, 'TOKEN_EXPIRED');
    }
    throw new AppError('Invalid access token.', 401, 'INVALID_TOKEN');
  }
};

export default {
  hashToken,
  generateRefreshToken,
  generateAccessToken,
  verifyAccessToken,
  getRefreshTokenExpiryMs,
  getAccessTokenExpiry,
};
