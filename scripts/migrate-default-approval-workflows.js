import mongoose from 'mongoose';
import { connectDatabase } from '../src/config/db.js';
import Organization from '../src/models/Organization.js';
import WorkflowDefinition from '../src/models/WorkflowDefinition.js';
import { withTransaction } from '../src/utils/transaction.js';
import { initializeDefaultApprovalWorkflow } from '../src/modules/requests/approvalWorkflow.service.js';

await connectDatabase();
const organizations = await Organization.find({}).select('_id name createdBy').lean();
let initialized = 0;

try {
  for (const organization of organizations) {
    const existed = await WorkflowDefinition.exists({
      organizationId: organization._id,
      definitionType: 'APPROVAL_WORKFLOW',
      isDefault: true,
    });
    const workflow = await withTransaction((session) => initializeDefaultApprovalWorkflow({
      session,
      organizationId: organization._id,
      actorId: organization.createdBy,
    }));
    if (!existed && workflow) initialized += 1;
    console.log(`${organization.name} (${organization._id}): ${existed ? 'existing default preserved' : 'default initialized'}`);
  }
  console.log(`Default approval workflow synchronization completed for ${organizations.length} organizations; initialized ${initialized}.`);
} finally {
  await mongoose.disconnect();
}
