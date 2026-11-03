import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  TEST_PASSWORD,
  connectTestDatabase,
  createUser,
  disconnectTestDatabase,
  resetTestDatabase,
  User,
} from './helpers.js';
import { verifyPassword } from '../src/utils/password.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, '..');

const runSeed = (envOverrides = {}) =>
  new Promise((resolve) => {
    const child = spawn('node', ['scripts/seed-super-admin.js'], {
      cwd: backendRoot,
      env: {
        ...process.env,
        MONGODB_URI: 'mongodb://127.0.0.1:27017/accessflow_test',
        SUPER_ADMIN_NAME: 'Seeded Super Admin',
        SUPER_ADMIN_EMAIL: 'seeded-super@example.com',
        SUPER_ADMIN_PASSWORD: TEST_PASSWORD,
        ...envOverrides,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });

describe('Super Admin seeding', () => {
  beforeAll(async () => {
    await connectTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await disconnectTestDatabase();
  });

  it('creates a Super Admin successfully', async () => {
    const result = await runSeed();
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/created successfully/i);

    const user = await User.findOne({ email: 'seeded-super@example.com' });
    expect(user).toBeTruthy();
    expect(user.platformRole).toBe('SUPER_ADMIN');
    expect(user.organizationMemberships).toEqual([]);
    expect(user.passwordHash).toBeTruthy();
    expect(user.passwordHash).not.toBe(TEST_PASSWORD);
    expect(await verifyPassword(TEST_PASSWORD, user.passwordHash)).toBe(true);
  });

  it('is idempotent and does not duplicate or overwrite', async () => {
    await runSeed();
    const first = await User.findOne({ email: 'seeded-super@example.com' });
    const firstHash = first.passwordHash;

    const second = await runSeed();
    expect(second.code).toBe(0);
    expect(second.stdout).toMatch(/already exists/i);

    const users = await User.find({ email: 'seeded-super@example.com' });
    expect(users).toHaveLength(1);
    expect(users[0].passwordHash).toBe(firstHash);
    expect(users[0].platformRole).toBe('SUPER_ADMIN');
  });

  it('refuses to convert an existing regular user into Super Admin', async () => {
    await createUser({
      email: 'seeded-super@example.com',
      platformRole: null,
    });

    const result = await runSeed();
    expect(result.code).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/Refusing to convert/i);

    const user = await User.findOne({ email: 'seeded-super@example.com' });
    expect(user.platformRole).toBeNull();
  });

  it('fails clearly when required environment variables are missing', async () => {
    const result = await runSeed({
      SUPER_ADMIN_NAME: '',
      SUPER_ADMIN_EMAIL: '',
      SUPER_ADMIN_PASSWORD: '',
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/must be set/i);
  });
});
