import { Resend } from 'resend';
import { AppError } from '../../utils/AppError.js';
import { env } from '../../config/env.js';

let resendClient;

export const sendWithResend = async ({ from, to, subject, html, text }) => {
  if (!env.RESEND_API_KEY) {
    throw new AppError('Email delivery is not configured.', 503, 'EMAIL_NOT_CONFIGURED');
  }

  resendClient ||= new Resend(env.RESEND_API_KEY);
  try {
    const result = await resendClient.emails.send({ from, to, subject, html, text });
    if (result.error) {
      throw new Error('Provider rejected the email.');
    }
    return result.data;
  } catch {
    throw new AppError('Email could not be delivered.', 502, 'EMAIL_DELIVERY_FAILED');
  }
};

export default sendWithResend;