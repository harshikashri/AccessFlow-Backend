import {
  clearRefreshTokenCookie,
  REFRESH_TOKEN_COOKIE,
  setRefreshTokenCookie,
} from '../../utils/cookie.js';
import { AppError } from '../../utils/AppError.js';
import * as authService from './auth.service.js';
import { validateLoginInput } from './auth.validation.js';

const clearAuthCookie = (res) => {
  clearRefreshTokenCookie(res);
};

export const login = async (req, res) => {
  const input = validateLoginInput(req.body);
  const result = await authService.login(input);

  setRefreshTokenCookie(res, result.refreshToken);

  return res.status(200).json({
    success: true,
    message: 'Login successful',
    data: {
      accessToken: result.accessToken,
      user: result.user,
    },
  });
};

export const refresh = async (req, res) => {
  const rawRefreshToken = req.cookies?.[REFRESH_TOKEN_COOKIE];

  try {
    const result = await authService.refresh(rawRefreshToken);
    setRefreshTokenCookie(res, result.refreshToken);

    return res.status(200).json({
      success: true,
      message: 'Token refreshed successfully',
      data: {
        accessToken: result.accessToken,
        user: result.user,
      },
    });
  } catch (error) {
    clearAuthCookie(res);
    throw error;
  }
};

export const logout = async (req, res) => {
  if (req.auth?.userId && req.auth?.sessionId) {
    await authService.logout({
      userId: req.auth.userId,
      sessionId: req.auth.sessionId,
    });
  }

  clearAuthCookie(res);

  return res.status(200).json({
    success: true,
    message: 'Logout successful',
  });
};

export const logoutAll = async (req, res) => {
  if (!req.auth?.userId) {
    throw new AppError('Authentication required.', 401, 'UNAUTHORIZED');
  }

  const result = await authService.logoutAll(req.auth.userId);
  clearAuthCookie(res);

  return res.status(200).json({
    success: true,
    message: 'Logged out from all sessions',
    data: {
      revokedCount: result.revokedCount,
    },
  });
};

export const me = async (req, res) => {
  const result = await authService.getCurrentUser({
    userId: req.auth.userId,
    sessionId: req.auth.sessionId,
  });

  return res.status(200).json({
    success: true,
    data: result,
  });
};

export default {
  login,
  refresh,
  logout,
  logoutAll,
  me,
};
