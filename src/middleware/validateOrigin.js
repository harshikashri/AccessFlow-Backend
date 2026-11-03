import { env } from '../config/env.js';
import { AppError } from '../utils/AppError.js';

/**
 * Lightweight CSRF mitigation for cookie-authenticated auth endpoints.
 * Requires Origin (or Referer) to match CLIENT_URL when present.
 * SameSite=lax already reduces cross-site POST risk for top-level navigations.
 */
export const validateAuthOrigin = (req, res, next) => {
  const allowedOrigin = env.CLIENT_URL;
  const origin = req.get('origin');
  const referer = req.get('referer');

  if (!origin && !referer) {
    // Allow non-browser clients (Postman, server-to-server) without Origin.
    return next();
  }

  const candidate = origin || (referer ? new URL(referer).origin : null);
  if (candidate !== allowedOrigin) {
    return next(new AppError('Request origin is not allowed.', 403, 'INVALID_ORIGIN'));
  }

  return next();
};

export default validateAuthOrigin;
