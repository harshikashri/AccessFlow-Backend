import mongoose from 'mongoose';
import { connectDatabase } from '../src/config/db.js';
import { migratePurchaseAmountSemantic } from '../src/modules/requests/requestType.migrations.js';

const dryRun = process.argv.slice(2).includes('--dry-run');

try {
  await connectDatabase();
  const result = await migratePurchaseAmountSemantic({ dryRun });
  console.log(
    `Purchase Request amount semantic migration ${dryRun ? 'dry run' : 'completed'}: ` +
    `${result.migrated} migrated, ${result.alreadyConfigured} already configured, ${result.skipped} safely skipped, ` +
    `${result.scanned} scanned.`
  );
} finally {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
}
