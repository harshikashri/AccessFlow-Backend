import { AppError } from '../utils/AppError.js';

export const requireSuperAdmin = (req, res, next) => {
  if (!req.auth?.userId) {
    return next(new AppError('Authentication required.', 401, 'UNAUTHORIZED'));
  }

  if (req.auth.platformRole !== 'SUPER_ADMIN') {
    return next(
      new AppError(
        'Only Super Admin can perform this operation.',
        403,
        'FORBIDDEN'
      )
    );
  }

  return next();
};

export default {
  requireSuperAdmin,
};
