export {
  authRateLimiter,
  forgotPasswordAccountRateLimiter,
  loginAccountRateLimiter,
  passwordResetRateLimiter,
} from './rateLimiters.js';

import { authRateLimiter } from './rateLimiters.js';

export default authRateLimiter;
