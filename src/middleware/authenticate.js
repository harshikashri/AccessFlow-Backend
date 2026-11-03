import { loadAuthContext } from '../modules/auth/auth.service.js';
import { AppError } from '../utils/AppError.js';
import { verifyAccessToken } from '../utils/token.js';

export const authenticate = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || typeof header !== 'string') {
      throw new AppError('Authentication required.', 401, 'UNAUTHORIZED');
    }

    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw new AppError('Invalid Authorization header format.', 401, 'UNAUTHORIZED');
    }

    const payload = verifyAccessToken(token);
    if (!payload?.userId || !payload?.sessionId) {
      throw new AppError('Invalid access token payload.', 401, 'INVALID_TOKEN');
    }

    const context = await loadAuthContext({
      userId: payload.userId,
      sessionId: payload.sessionId,
      organizationId: payload.organizationId ?? null,
      platformRole: payload.platformRole ?? null,
    });

    req.user = context.user;
    req.session = context.session;
    req.auth = context.auth;

    return next();
  } catch (error) {
    return next(error);
  }
};

export const authenticateOptional = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header) {
      return next();
    }
    return authenticate(req, res, next);
  } catch (error) {
    return next(error);
  }
};

export default authenticate;
