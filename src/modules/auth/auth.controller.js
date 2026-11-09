import {
  clearRefreshTokenCookie,
  REFRESH_TOKEN_COOKIE,
  setRefreshTokenCookie,
} from '../../utils/cookie.js';
import { AppError } from '../../utils/AppError.js';
import * as authService from './auth.service.js';
import {
  validateForgotPasswordInput,
  validateLoginInput,
  validateResetPasswordInput,
  validateSetPasswordInput,
} from './auth.validation.js';
import * as passwordResetService from './password-reset.service.js';

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

export const setPassword = async (req, res) => {
  const input = validateSetPasswordInput(req.body);
  await passwordResetService.completeInitialPasswordSetup(input);
  return res.status(200).json({ success: true, message: 'Password setup completed. You can now sign in.' });
};

export const forgotPassword = async (req, res) => {
  const { email } = validateForgotPasswordInput(req.body);
  await passwordResetService.requestForgotPassword(email);
  return res.status(200).json({
    success: true,
    message: 'If an eligible account exists, password instructions were requested. This response does not confirm email delivery.',
  });
};

export const resetPassword = async (req, res) => {
  const input = validateResetPasswordInput(req.body);
  await passwordResetService.completePasswordReset(input);
  return res.status(200).json({
    success: true,
    message: 'Password reset completed. Please sign in again.',
  });
};

export default {
  login,
  refresh,
  logout,
  logoutAll,
  me,
  setPassword,
  forgotPassword,
  resetPassword,
};
