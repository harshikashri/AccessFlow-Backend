import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authRateLimiter } from '../../middleware/authRateLimit.js';
import { validateAuthOrigin } from '../../middleware/validateOrigin.js';
import * as authController from './auth.controller.js';
import { loadAuthContext } from './auth.service.js';
import { verifyAccessToken } from '../../utils/token.js';

const router = Router();

/**
 * Attempts authentication for logout without failing the request when the
 * access token is missing or invalid. Cookie clearing remains idempotent.
 */
const softAuthenticate = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || typeof header !== 'string') {
      return next();
    }

    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      return next();
    }

    const payload = verifyAccessToken(token);
    const context = await loadAuthContext({
      userId: payload.userId,
      sessionId: payload.sessionId,
      organizationId: payload.organizationId ?? null,
      platformRole: payload.platformRole ?? null,
    });

    req.user = context.user;
    req.session = context.session;
    req.auth = context.auth;
  } catch {
    req.auth = null;
  }

  return next();
};

router.post(
  '/login',
  authRateLimiter,
  validateAuthOrigin,
  asyncHandler(authController.login)
);

router.post(
  '/refresh',
  authRateLimiter,
  validateAuthOrigin,
  asyncHandler(authController.refresh)
);

router.post(
  '/logout',
  validateAuthOrigin,
  asyncHandler(softAuthenticate),
  asyncHandler(authController.logout)
);

router.post(
  '/logout-all',
  validateAuthOrigin,
  authenticate,
  asyncHandler(authController.logoutAll)
);

router.get('/me', authenticate, asyncHandler(authController.me));

export default router;
