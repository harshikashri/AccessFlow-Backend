import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseTrustProxy } from '../src/config/env.js';
import {
  createAccountRateLimiter,
  createEndpointRateLimiter,
  createOperationRateLimiter,
  createRateLimiter,
} from '../src/middleware/rateLimiters.js';
import { connectTestDatabase, disconnectTestDatabase } from './helpers.js';

function createApp(limiter, { trustProxy = false, handler } = {}) {
  const app = express();
  app.set('trust proxy', trustProxy);
  app.use(express.json());
  app.get('/resource', limiter, (req, res) => res.status(200).json({ success: true }));
  app.post(
    '/auth',
    limiter,
    handler ?? ((req, res) => res.status(200).json({ success: true })),
  );
  app.post(
    '/api/users/bulk',
    (req, res, next) => {
      req.user = { id: req.body.userId };
      next();
    },
    limiter,
    (req, res) => res.status(200).json({ success: true }),
  );
  return app;
}

describe('rate limiters', () => {
  beforeAll(async () => connectTestDatabase());
  afterAll(async () => disconnectTestDatabase());

  it('returns a consistent JSON 429 response with standard headers at the configured threshold', async () => {
    const app = createApp(
      createRateLimiter({
        windowMs: 60_000,
        limit: 2,
        message: { success: false, code: 'RATE_LIMITED' },
      }),
    );

    expect((await request(app).get('/resource')).status).toBe(200);
    expect((await request(app).get('/resource')).status).toBe(200);
    const limited = await request(app).get('/resource');

    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ success: false, code: 'RATE_LIMITED' });
    expect(limited.headers['ratelimit-policy']).toBeTruthy();
  });

  it('allows requests again after the rate-limit window expires', async () => {
    const app = createApp(createRateLimiter({ windowMs: 50, limit: 1 }));

    expect((await request(app).get('/resource')).status).toBe(200);
    expect((await request(app).get('/resource')).status).toBe(429);
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect((await request(app).get('/resource')).status).toBe(200);
  });

  it('keeps authentication endpoint budgets independent', async () => {
    const app = createApp(createEndpointRateLimiter({ windowMs: 60_000, limit: 1 }));

    expect((await request(app).get('/resource')).status).toBe(200);
    expect((await request(app).post('/auth').send({})).status).toBe(200);
    expect((await request(app).get('/resource')).status).toBe(429);
  });

  it('keys failed login attempts by IP and normalized account, excluding successful logins', async () => {
    const app = createApp(
      createAccountRateLimiter({
        windowMs: 60_000,
        limit: 2,
        skipSuccessfulRequests: true,
      }),
      {
        handler: (req, res) =>
          res.status(req.body.password === 'valid' ? 200 : 401).json({ success: false }),
      },
    );

    expect(
      (await request(app).post('/auth').send({ email: 'User@example.com', password: 'valid' }))
        .status,
    ).toBe(200);
    expect(
      (await request(app).post('/auth').send({ email: 'user@example.com', password: 'wrong' }))
        .status,
    ).toBe(401);
    expect(
      (await request(app).post('/auth').send({ email: 'USER@example.com', password: 'wrong' }))
        .status,
    ).toBe(401);
    expect(
      (await request(app).post('/auth').send({ email: 'user@example.com', password: 'wrong' }))
        .status,
    ).toBe(429);
    expect(
      (await request(app).post('/auth').send({ email: 'other@example.com', password: 'wrong' }))
        .status,
    ).toBe(401);

    const trustedProxyApp = createApp(
      createAccountRateLimiter({ windowMs: 60_000, limit: 1 }),
      { trustProxy: 1 },
    );
    expect(
      (
        await request(trustedProxyApp)
          .post('/auth')
          .set('X-Forwarded-For', '198.51.100.10')
          .send({ email: 'same@example.com' })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(trustedProxyApp)
          .post('/auth')
          .set('X-Forwarded-For', '198.51.100.20')
          .send({ email: 'same@example.com' })
      ).status,
    ).toBe(200);
  });

  it('isolates operation limits per authenticated actor and endpoint', async () => {
    const app = createApp(createOperationRateLimiter({ windowMs: 60_000, limit: 1 }));

    expect((await request(app).post('/api/users/bulk').send({ userId: 'user-a' })).status).toBe(200);
    expect((await request(app).post('/api/users/bulk').send({ userId: 'user-a' })).status).toBe(429);
    expect((await request(app).post('/api/users/bulk').send({ userId: 'user-b' })).status).toBe(200);
  });

  it('keeps proxy trust disabled by default and supports explicit hop/IP configuration', async () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('10.0.0.0/8')).toBe('10.0.0.0/8');

    const app = createApp(createRateLimiter({ windowMs: 60_000, limit: 1 }));
    expect(
      (
        await request(app)
          .get('/resource')
          .set('X-Forwarded-For', '198.51.100.10')
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .get('/resource')
          .set('X-Forwarded-For', '198.51.100.20')
      ).status,
    ).toBe(429);

    const trustedProxyApp = createApp(
      createRateLimiter({ windowMs: 60_000, limit: 1 }),
      { trustProxy: 1 },
    );
    expect(
      (
        await request(trustedProxyApp)
          .get('/resource')
          .set('X-Forwarded-For', '198.51.100.10')
      ).status,
    ).toBe(200);
    expect(
      (
        await request(trustedProxyApp)
          .get('/resource')
          .set('X-Forwarded-For', '198.51.100.20')
      ).status,
    ).toBe(200);
  });
});
