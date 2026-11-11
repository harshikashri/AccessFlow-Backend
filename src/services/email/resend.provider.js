import { Resend } from 'resend';
import { AppError } from '../../utils/AppError.js';
import { env } from '../../config/env.js';

let resendClient;

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const redact = (value, { apiKey, to, from, html, text }) => {
  let message = String(value || 'Provider rejected the email.');
  for (const secret of [apiKey, to, from]) {
    if (secret) message = message.replaceAll(secret, '[REDACTED]');
  }
  for (const content of [html, text]) {
    if (!content) continue;
    for (const match of content.matchAll(/[?&]token=([^&\s"'<>]+)/gi)) {
      const token = match[1];
      message = message.replace(new RegExp(escapeRegExp(token), 'g'), '[REDACTED]');
      try {
        const decodedToken = decodeURIComponent(token);
        message = message.replace(new RegExp(escapeRegExp(decodedToken), 'g'), '[REDACTED]');
      } catch {
        // The encoded value has already been redacted.
      }
    }
  }
  return message
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
    .replace(/((?:api[_-]?key|authorization|password|token)\s*[:=]\s*["']?)[^"'&\s,}]+/gi, '$1[REDACTED]')
    .replace(/((?:[?&]token=))[^&\s"'<>]+/gi, '$1[REDACTED]')
    .slice(0, 500);
};

const logProviderError = (error, payload, apiKey) => {
  const context = { ...payload, apiKey };
  const details = {
    name: redact(error?.name || 'ProviderError', context).slice(0, 100),
    ...(typeof error?.statusCode === 'number' ? { statusCode: error.statusCode } : {}),
    ...(typeof error?.code === 'string' ? { code: redact(error.code, context).slice(0, 100) } : {}),
    message: redact(error?.message, context),
  };
  console.error('Resend email delivery failed:', details);
};

export const sendWithResend = async ({ from, to, subject, html, text }) => {
  if (!env.RESEND_API_KEY) {
    throw new AppError('Email delivery is not configured.', 503, 'EMAIL_NOT_CONFIGURED');
  }
  if (env.NODE_ENV === 'test') {
    return { id: 'test-email' };
  }

  resendClient ||= new Resend(env.RESEND_API_KEY);
  try {
    const result = await resendClient.emails.send({ from, to, subject, html, text });
    if (result.error) {
      throw result.error;
    }
    return result.data;
  } catch (error) {
    logProviderError(error, { from, to, html, text }, env.RESEND_API_KEY);
    throw new AppError('Email could not be delivered.', 502, 'EMAIL_DELIVERY_FAILED');
  }
};

export default sendWithResend;