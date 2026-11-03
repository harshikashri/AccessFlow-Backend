import { env } from '../config/env.js';
import { getRefreshTokenExpiryMs } from './token.js';

export const REFRESH_TOKEN_COOKIE = 'refreshToken';

export const getRefreshTokenCookieOptions = () => {
  const options = {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAME_SITE,
    path: env.COOKIE_PATH,
    maxAge: getRefreshTokenExpiryMs(),
  };

  if (env.COOKIE_DOMAIN) {
    options.domain = env.COOKIE_DOMAIN;
  }

  return options;
};

export const getClearRefreshTokenCookieOptions = () => {
  const options = getRefreshTokenCookieOptions();
  delete options.maxAge;
  return options;
};

export const setRefreshTokenCookie = (res, refreshToken) => {
  res.cookie(REFRESH_TOKEN_COOKIE, refreshToken, getRefreshTokenCookieOptions());
};

export const clearRefreshTokenCookie = (res) => {
  res.clearCookie(REFRESH_TOKEN_COOKIE, getClearRefreshTokenCookieOptions());
};

export default {
  REFRESH_TOKEN_COOKIE,
  getRefreshTokenCookieOptions,
  setRefreshTokenCookie,
  clearRefreshTokenCookie,
};
