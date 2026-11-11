import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({ emails: { send: sendMock } })),
}));

import { env } from '../../src/config/env.js';
import { sendWithResend } from '../../src/services/email/resend.provider.js';

const originalEnvironment = {
  nodeEnv: env.NODE_ENV,
  apiKey: env.RESEND_API_KEY,
};

describe('Resend provider', () => {
  beforeEach(() => {
    env.NODE_ENV = 'development';
    env.RESEND_API_KEY = 're_test_local_only';
    sendMock.mockReset();
  });

  afterEach(() => {
    env.NODE_ENV = originalEnvironment.nodeEnv;
    env.RESEND_API_KEY = originalEnvironment.apiKey;
    vi.restoreAllMocks();
  });

  it('sends the configured sender, recipient and rendered email payload through Resend', async () => {
    const response = { id: 'resend-message-id' };
    sendMock.mockResolvedValueOnce({ data: response, error: null });
    const payload = {
      from: 'AccessFlow <onboarding@resend.dev>',
      to: 'recipient@example.com',
      subject: 'Set your AccessFlow password',
      html: '<a href="https://example.test/set-password?token=sample-token">Set password</a>',
      text: 'Open the setup link.',
    };

    await expect(sendWithResend(payload)).resolves.toEqual(response);
    expect(sendMock).toHaveBeenCalledWith(payload);
  });

  it('logs useful provider error metadata while redacting credentials, recipient and setup token', async () => {
    const token = 'setup-token-that-must-not-be-logged';
    sendMock.mockResolvedValueOnce({
      data: null,
      error: {
        name: 'validation_error',
        statusCode: 422,
        code: 'invalid_from',
        message: `Invalid sender from onboarding@resend.dev for recipient@example.com. re_test_local_only token=${token}`,
      },
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const payload = {
      from: 'AccessFlow <onboarding@resend.dev>',
      to: 'recipient@example.com',
      subject: 'Set password',
      html: `<a href="https://example.test/set-password?token=${token}">Set password</a>`,
      text: `token=${token}`,
    };

    await expect(sendWithResend(payload)).rejects.toMatchObject({
      statusCode: 502,
      code: 'EMAIL_DELIVERY_FAILED',
    });

    expect(log).toHaveBeenCalledOnce();
    const loggedDetails = JSON.stringify(log.mock.calls[0]);
    expect(loggedDetails).toContain('validation_error');
    expect(loggedDetails).toContain('422');
    expect(loggedDetails).toContain('invalid_from');
    expect(loggedDetails).not.toContain('re_test_local_only');
    expect(loggedDetails).not.toContain(token);
    expect(loggedDetails).not.toContain('recipient@example.com');
    expect(loggedDetails).not.toContain('onboarding@resend.dev');
  });
});
