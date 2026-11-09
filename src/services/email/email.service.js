import { AppError } from '../../utils/AppError.js';
import { env } from '../../config/env.js';
import { sendWithResend } from './resend.provider.js';

export const assertEmailConfiguration = () => {
  if (!env.EMAIL_PROVIDER || !env.EMAIL_FROM) {
    throw new AppError('Email delivery is not configured.', 503, 'EMAIL_NOT_CONFIGURED');
  }
  if (env.EMAIL_PROVIDER !== 'resend') {
    throw new AppError('The configured email provider is unsupported.', 503, 'EMAIL_NOT_CONFIGURED');
  }
  if (!env.RESEND_API_KEY) {
    throw new AppError('Email delivery is not configured.', 503, 'EMAIL_NOT_CONFIGURED');
  }
  if (env.EMAIL_TEST_MODE && !env.EMAIL_TEST_RECIPIENT) {
    throw new AppError('Email test recipient is not configured.', 503, 'EMAIL_NOT_CONFIGURED');
  }
};

export const sendEmail = async ({ to, subject, html, text }) => {
  assertEmailConfiguration();

  let recipient = to;
  if (env.EMAIL_TEST_MODE) {
    recipient = env.EMAIL_TEST_RECIPIENT;
  }

  return sendWithResend({ from: env.EMAIL_FROM, to: recipient, subject, html, text });
};

export default { assertEmailConfiguration, sendEmail };