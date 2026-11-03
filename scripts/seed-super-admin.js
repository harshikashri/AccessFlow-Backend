/**
 * Idempotent Super Admin seed script.
 * Run explicitly: npm run seed:super-admin
 * Never auto-runs on server start.
 */
import { env } from '../src/config/env.js';
import { connectDatabase } from '../src/config/db.js';
import User from '../src/models/User.js';
import { hashPassword, validatePasswordStrength } from '../src/utils/password.js';
import { isValidEmail, normalizeEmail } from '../src/modules/auth/auth.validation.js';
import mongoose from 'mongoose';

const fail = (message) => {
  console.error(`Super Admin seed failed: ${message}`);
  process.exitCode = 1;
};

const seedSuperAdmin = async () => {
  const name = env.SUPER_ADMIN_NAME;
  const email = normalizeEmail(env.SUPER_ADMIN_EMAIL);
  const password = env.SUPER_ADMIN_PASSWORD;

  if (!name || !email || !password) {
    fail(
      'SUPER_ADMIN_NAME, SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must be set in the environment.'
    );
    return;
  }

  if (name.trim().length < 2) {
    fail('SUPER_ADMIN_NAME must be at least 2 characters.');
    return;
  }

  if (!isValidEmail(email)) {
    fail('SUPER_ADMIN_EMAIL must be a valid email address.');
    return;
  }

  try {
    validatePasswordStrength(password);
  } catch (error) {
    fail(error.message);
    return;
  }

  await connectDatabase();

  const existing = await User.findOne({ email });
  if (existing) {
    if (existing.platformRole === 'SUPER_ADMIN') {
      console.log(`Super Admin already exists for email ${email}. No changes were made.`);
      return;
    }

    fail(
      `A non-Super-Admin user already exists for email ${email}. Refusing to convert that account.`
    );
    return;
  }

  const passwordHash = await hashPassword(password);

  await User.create({
    name: name.trim(),
    email,
    passwordHash,
    platformRole: 'SUPER_ADMIN',
    organizationMemberships: [],
    accountStatus: 'ACTIVE',
  });

  console.log(`Super Admin created successfully for email ${email}.`);
};

seedSuperAdmin()
  .catch((error) => {
    console.error('Super Admin seed failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });
