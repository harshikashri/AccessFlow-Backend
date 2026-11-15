import crypto from 'crypto';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { env } from '../config/env.js';

const rateLimitMessage = {
  success: false,
  message: 'Too many requests. Please try again later.',
  code: 'RATE_LIMITED',
};

const authenticationRateLimitMessage = {
  ...rateLimitMessage,
  message: 'Too many authentication attempts. Please try again later.',
};

function ipKey(req) {
  return ipKeyGenerator(req.ip || req.socket.remoteAddress || 'unknown');
}

function accountKey(req) {
  const identifier =
    typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const digest = crypto.createHash('sha256').update(identifier).digest('hex');
  return `${ipKey(req)}:${digest}`;
}

function operationKey(req) {
  const actorId = typeof req.user?.id === 'string' ? req.user.id : 'anonymous';
  const routePath = typeof req.route?.path === 'string' ? req.route.path : req.path;
  return `${ipKey(req)}:${actorId}:${req.baseUrl}${routePath}`;
}

function endpointKey(req) {
  const routePath = typeof req.route?.path === 'string' ? req.route.path : req.path;
  return `${ipKey(req)}:${req.baseUrl}${routePath}`;
}

export function createRateLimiter({
  windowMs,
  limit,
  keyGenerator = ipKey,
  message = rateLimitMessage,
  skipSuccessfulRequests = false,
}) {
  return rateLimit({
    windowMs,
    limit,
    keyGenerator,
    message,
    skipSuccessfulRequests,
    standardHeaders: true,
    legacyHeaders: false,
  });
}

export function createAccountRateLimiter(options) {
  return createRateLimiter({ ...options, keyGenerator: accountKey });
}

export function createEndpointRateLimiter(options) {
  return createRateLimiter({ ...options, keyGenerator: endpointKey });
}

export function createOperationRateLimiter(options) {
  return createRateLimiter({ ...options, keyGenerator: operationKey });
}

export const apiRateLimiter = createRateLimiter({
  windowMs: env.API_RATE_LIMIT_WINDOW_MS,
  limit: env.API_RATE_LIMIT_MAX,
});

export const authRateLimiter = createEndpointRateLimiter({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_RATE_LIMIT_MAX,
  message: authenticationRateLimitMessage,
});

export const loginAccountRateLimiter = createAccountRateLimiter({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  limit: env.LOGIN_ACCOUNT_RATE_LIMIT_MAX,
  message: authenticationRateLimitMessage,
  skipSuccessfulRequests: true,
});

export const forgotPasswordAccountRateLimiter = createAccountRateLimiter({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  limit: env.FORGOT_PASSWORD_ACCOUNT_RATE_LIMIT_MAX,
  message: authenticationRateLimitMessage,
});

export const passwordResetRateLimiter = createEndpointRateLimiter({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  limit: env.PASSWORD_RESET_RATE_LIMIT_MAX,
  message: authenticationRateLimitMessage,
});

export const sensitiveOperationRateLimiter = createOperationRateLimiter({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  limit: env.SENSITIVE_OPERATION_RATE_LIMIT_MAX,
});

export const bulkOperationRateLimiter = createOperationRateLimiter({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  limit: env.BULK_OPERATION_RATE_LIMIT_MAX,
});
