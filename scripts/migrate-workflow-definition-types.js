import mongoose from 'mongoose';
import { connectDatabase } from '../src/config/db.js';
import WorkflowDefinition from '../src/models/WorkflowDefinition.js';

const dryRun = process.argv.slice(2).includes('--dry-run');

const run = async () => {
  await connectDatabase();
  const legacy = await WorkflowDefinition.find({
    definitionType: { $exists: false },
  }).select('_id organizationId name requestType').lean();

  if (!legacy.length) {
    console.log('Workflow definition discriminator migration: no changes needed.');
    return;
  }

  console.log(`${dryRun ? 'Would mark' : 'Marking'} ${legacy.length} legacy workflow definitions as APPROVAL_WORKFLOW.`);
  for (const definition of legacy) {
    console.log(JSON.stringify({
      id: String(definition._id),
      organizationId: String(definition.organizationId),
      name: definition.name,
      requestType: definition.requestType,
      definitionType: 'APPROVAL_WORKFLOW',
    }));
  }

  if (!dryRun) {
    await WorkflowDefinition.updateMany(
      { definitionType: { $exists: false } },
      { $set: { definitionType: 'APPROVAL_WORKFLOW' } }
    );
    const remaining = await WorkflowDefinition.countDocuments({ definitionType: { $exists: false } });
    if (remaining !== 0) throw new Error(`Workflow discriminator migration incomplete: ${remaining} documents remain.`);
    console.log('Workflow definition discriminator migration completed.');
  }
};

try {
  await run();
} finally {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
}

