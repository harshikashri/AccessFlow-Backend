import mongoose from 'mongoose';
import { connectDatabase } from '../src/config/db.js';
import Organization from '../src/models/Organization.js';
import Role from '../src/models/Role.js';
import AuditLog from '../src/models/AuditLog.js';
import {
  DEPARTMENT_MANAGER_PERMISSIONS,
  DEPARTMENT_MANAGER_ROLE_NAME,
  DEPARTMENT_MEMBER_PERMISSIONS,
  DEPARTMENT_MEMBER_ROLE_NAME,
  ORGANIZATION_ADMIN_PERMISSIONS,
  ORGANIZATION_ADMIN_ROLE_NAME,
} from '../src/config/constants.js';
import { normalizeRoleName } from '../src/modules/roles/role.utils.js';

const dryRun = process.argv.slice(2).includes('--dry-run');
const definitions = [
  {
    roleType: 'ORGANIZATION_ADMIN',
    name: ORGANIZATION_ADMIN_ROLE_NAME,
    permissions: ORGANIZATION_ADMIN_PERMISSIONS,
    description: 'Default organization administrator role.',
  },
  {
    roleType: 'DEPARTMENT_MANAGER',
    name: DEPARTMENT_MANAGER_ROLE_NAME,
    permissions: DEPARTMENT_MANAGER_PERMISSIONS,
    description: 'Default department manager role.',
  },
  {
    roleType: 'EMPLOYEE',
    name: DEPARTMENT_MEMBER_ROLE_NAME,
    permissions: DEPARTMENT_MEMBER_PERMISSIONS,
    description: 'Default department member role.',
  },
];

const findRole = async (organizationId, definition, session) => {
  const roles = await Role.find({
    organizationId,
    $or: [
      { roleType: definition.roleType },
      { nameNormalized: normalizeRoleName(definition.name) },
      { name: definition.name },
    ],
  }).session(session);
  const matching = roles.filter((role) =>
    role.roleType === definition.roleType ||
    normalizeRoleName(role.name) === normalizeRoleName(definition.name)
  );
  if (matching.length > 1) {
    throw new Error(
      `Ambiguous ${definition.roleType} roles for organization ${organizationId}: ${matching.map((role) => role._id).join(', ')}`
    );
  }
  const reservedNameConflict = roles.find(
    (role) => normalizeRoleName(role.name) === normalizeRoleName(definition.name) &&
      role.roleType && role.roleType !== definition.roleType
  );
  if (reservedNameConflict) {
    throw new Error(
      `Reserved role name conflict for organization ${organizationId}: ${reservedNameConflict._id}`
    );
  }
  return matching[0] || null;
};

const processOrganization = async (organization) => {
  const session = await mongoose.startSession();
  try {
    let changes = [];
    await session.withTransaction(async () => {
      for (const definition of definitions) {
        const role = await findRole(organization._id, definition, session);
        if (role) {
          if (role.roleType !== definition.roleType) {
            if (dryRun) {
              changes.push(`set roleType=${definition.roleType} on ${role._id}`);
            } else {
              role.roleType = definition.roleType;
              await role.save({ session });
              await AuditLog.create([{
                organizationId: organization._id,
                actorId: organization.createdBy,
                action: 'DEFAULT_ROLE_BACKFILLED',
                resourceType: 'Role',
                resourceId: role._id,
                changes: { roleType: { from: null, to: definition.roleType } },
                timestamp: new Date(),
              }], { session });
            }
          }
          continue;
        }
        changes.push(`create ${definition.roleType} (${definition.name})`);
        if (!dryRun) {
          const [created] = await Role.create([{
            organizationId: organization._id,
            name: definition.name,
            roleType: definition.roleType,
            nameNormalized: normalizeRoleName(definition.name),
            description: definition.description,
            permissions: definition.permissions,
            status: 'ACTIVE',
            createdBy: organization.createdBy,
          }], { session });
          await AuditLog.create([{
            organizationId: organization._id,
            actorId: organization.createdBy,
            action: 'DEFAULT_ROLE_BACKFILLED',
            resourceType: 'Role',
            resourceId: created._id,
            changes: { roleType: definition.roleType, name: definition.name },
            timestamp: new Date(),
          }], { session });
        }
      }
    });
    return changes;
  } finally {
    await session.endSession();
  }
};

const run = async () => {
  await connectDatabase();
  const organizations = await Organization.find({}).select('_id name createdBy').lean();
  for (const organization of organizations) {
    const changes = await processOrganization(organization);
    console.log(`${organization.name} (${organization._id}): ${changes.length ? changes.join('; ') : 'no changes needed'}`);
  }
};

try {
  await run();
} catch (error) {
  console.error(`Default role migration ${dryRun ? 'dry-run' : 'failed'}: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
}
