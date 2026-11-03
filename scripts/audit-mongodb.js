/**
 * Temporary audit script — validates schemas, indexes, and collections.
 * Does not insert documents into MongoDB.
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { initializeDatabase } from '../src/config/db.js';
import Organization from '../src/models/Organization.js';
import Department from '../src/models/Department.js';
import User from '../src/models/User.js';
import Role from '../src/models/Role.js';
import UserRoleAssignment from '../src/models/UserRoleAssignment.js';
import Request from '../src/models/Request.js';
import ApprovalStep from '../src/models/ApprovalStep.js';
import WorkflowDefinition from '../src/models/WorkflowDefinition.js';
import AuditLog from '../src/models/AuditLog.js';
import Session from '../src/models/Session.js';

const oid = () => new mongoose.Types.ObjectId();

const EXPECTED_COLLECTIONS = [
  'organizations',
  'departments',
  'users',
  'roles',
  'userRoleAssignments',
  'requests',
  'approvalSteps',
  'workflowDefinitions',
  'auditLogs',
  'sessions',
];

const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ` — ${detail}` : ''}`);
}

async function validateDoc(Model, data, expectValid) {
  const doc = new Model(data);
  try {
    await doc.validate();
    if (expectValid) {
      return { ok: true, errors: null };
    }
    return { ok: false, errors: 'expected validation failure but passed' };
  } catch (error) {
    if (!expectValid) {
      return { ok: true, errors: error.message };
    }
    return { ok: false, errors: error.message };
  }
}

async function main() {
  // Capture mongoose index duplicate warnings
  const warnings = [];
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = (warning, ...args) => {
    const message = typeof warning === 'string' ? warning : warning?.message || String(warning);
    if (message.includes('Duplicate schema index')) {
      warnings.push(message);
    }
    return originalEmitWarning.call(process, warning, ...args);
  };

  console.log('=== Database initialization ===');
  const init = await initializeDatabase();
  record('initializeDatabase', true, `models=${init.models.join(',')}`);

  const db = mongoose.connection.db;
  const dbName = mongoose.connection.name;
  record('connected database name', dbName === 'accessflow', `name=${dbName}`);

  console.log('\n=== Collections ===');
  const collections = (await db.listCollections().toArray()).map((c) => c.name).sort();
  const appCollections = collections.filter((n) => !n.startsWith('system.'));
  record(
    'exact 10 application collections',
    appCollections.length === 10 && EXPECTED_COLLECTIONS.every((n) => appCollections.includes(n)),
    `found=[${appCollections.join(', ')}]`
  );
  record(
    'no additional application collections',
    appCollections.every((n) => EXPECTED_COLLECTIONS.includes(n)),
    `extra=[${appCollections.filter((n) => !EXPECTED_COLLECTIONS.includes(n)).join(', ') || 'none'}]`
  );

  console.log('\n=== Indexes ===');
  const indexReport = {};
  for (const name of EXPECTED_COLLECTIONS) {
    const indexes = await db.collection(name).indexes();
    indexReport[name] = indexes.map((idx) => ({ name: idx.name, key: idx.key, unique: !!idx.unique }));
    console.log(`${name}:`, JSON.stringify(indexReport[name]));
  }

  const deptUnique = indexReport.departments.some(
    (i) => i.unique && JSON.stringify(i.key) === JSON.stringify({ organizationId: 1, name: 1 })
  );
  record('departments unique compound index', deptUnique);

  const roleUnique = indexReport.roles.some(
    (i) => i.unique && JSON.stringify(i.key) === JSON.stringify({ organizationId: 1, name: 1 })
  );
  record('roles unique compound index', roleUnique);

  const usersEmailUnique = indexReport.users.some(
    (i) => i.unique && Object.keys(i.key).includes('email')
  );
  record('users email unique index', usersEmailUnique);

  const approvalUnique = indexReport.approvalSteps.some(
    (i) =>
      i.unique &&
      JSON.stringify(i.key) === JSON.stringify({ requestId: 1, attemptNumber: 1, sequence: 1 })
  );
  record('approvalSteps unique compound index', approvalUnique);

  const sessionTtl = indexReport.sessions.some((i) => i.key?.expiresAt === 1 && i.name?.includes('TTL') === false);
  // Check no expireAfterSeconds on sessions
  const sessionIndexesRaw = await db.collection('sessions').indexes();
  const hasTtl = sessionIndexesRaw.some((i) => i.expireAfterSeconds != null);
  record('sessions has no TTL auto-delete', !hasTtl, hasTtl ? 'TTL present' : 'no expireAfterSeconds');

  record('no duplicate schema index warnings', warnings.length === 0, warnings.join(' | ') || 'none');

  console.log('\n=== Schema validation (unsaved docs only) ===');

  // 1. Valid organization
  {
    const r = await validateDoc(
      Organization,
      { name: 'Acme Corp', status: 'ACTIVE', createdBy: oid() },
      true
    );
    record('1. Valid organization', r.ok, r.errors || '');
  }

  // Invalid organization (missing name)
  {
    const r = await validateDoc(Organization, { status: 'ACTIVE', createdBy: oid() }, false);
    record('1b. Invalid organization missing name', r.ok, r.errors || '');
  }

  // 2. Valid department
  {
    const r = await validateDoc(
      Department,
      { organizationId: oid(), name: 'Engineering', managerIds: [oid()], description: 'Eng dept', status: 'ACTIVE' },
      true
    );
    record('2. Valid department', r.ok, r.errors || '');
  }

  // 3. User with embedded organization membership
  {
    const r = await validateDoc(
      User,
      {
        name: 'Jane Doe',
        email: 'jane.doe@example.com',
        passwordHash: 'hashed-password-value',
        organizationMemberships: [
          {
            membershipId: oid(),
            organizationId: oid(),
            departmentId: oid(),
            status: 'ACTIVE',
          },
        ],
        accountStatus: 'ACTIVE',
        platformRole: null,
      },
      true
    );
    record('3. User with organization membership', r.ok, r.errors || '');
  }

  // User SUPER_ADMIN platformRole
  {
    const r = await validateDoc(
      User,
      {
        name: 'Super Admin',
        email: 'super@example.com',
        passwordHash: 'hashed',
        platformRole: 'SUPER_ADMIN',
      },
      true
    );
    record('3b. User with SUPER_ADMIN platformRole', r.ok, r.errors || '');
  }

  // Invalid email
  {
    const r = await validateDoc(
      User,
      { name: 'Bad', email: 'not-an-email', passwordHash: 'x' },
      false
    );
    record('3c. User invalid email rejected', r.ok, r.errors || '');
  }

  // 4. Role with embedded permissions
  {
    const r = await validateDoc(
      Role,
      {
        organizationId: oid(),
        name: 'Org Admin',
        description: 'Admin role',
        permissions: ['users.view', 'users.create', 'requests.approve'],
        status: 'ACTIVE',
        createdBy: oid(),
      },
      true
    );
    record('4. Role with permissions', r.ok, r.errors || '');
  }

  // Invalid permission
  {
    const r = await validateDoc(
      Role,
      {
        organizationId: oid(),
        name: 'Bad Role',
        permissions: ['not.a.real.permission'],
        createdBy: oid(),
      },
      false
    );
    record('4b. Role invalid permission rejected', r.ok, r.errors || '');
  }

  // 5. Organization-scoped role assignment
  {
    const r = await validateDoc(
      UserRoleAssignment,
      {
        userId: oid(),
        roleId: oid(),
        organizationId: oid(),
        departmentId: null,
        scopeType: 'ORGANIZATION',
        status: 'ACTIVE',
        assignedBy: oid(),
      },
      true
    );
    record('5. Organization-scoped role assignment', r.ok, r.errors || '');
  }

  // Org scope with departmentId should fail
  {
    const r = await validateDoc(
      UserRoleAssignment,
      {
        userId: oid(),
        roleId: oid(),
        organizationId: oid(),
        departmentId: oid(),
        scopeType: 'ORGANIZATION',
        assignedBy: oid(),
      },
      false
    );
    record('5b. Org scope with departmentId rejected', r.ok, r.errors || '');
  }

  // 6. Department-scoped role assignment
  {
    const r = await validateDoc(
      UserRoleAssignment,
      {
        userId: oid(),
        roleId: oid(),
        organizationId: oid(),
        departmentId: oid(),
        scopeType: 'DEPARTMENT',
        status: 'ACTIVE',
        assignedBy: oid(),
      },
      true
    );
    record('6. Department-scoped role assignment', r.ok, r.errors || '');
  }

  // Dept scope without departmentId should fail
  {
    const r = await validateDoc(
      UserRoleAssignment,
      {
        userId: oid(),
        roleId: oid(),
        organizationId: oid(),
        departmentId: null,
        scopeType: 'DEPARTMENT',
        assignedBy: oid(),
      },
      false
    );
    record('6b. Dept scope without departmentId rejected', r.ok, r.errors || '');
  }

  // 7. Valid purchase request
  {
    const r = await validateDoc(
      Request,
      {
        organizationId: oid(),
        requesterId: oid(),
        departmentId: oid(),
        requestType: 'PURCHASE',
        title: 'Laptop Purchase',
        description: 'Need a laptop',
        amount: 1200,
        status: 'DRAFT',
      },
      true
    );
    record('7. Valid purchase request', r.ok, r.errors || '');
  }

  // 8. Purchase without amount — must fail
  {
    const r = await validateDoc(
      Request,
      {
        organizationId: oid(),
        requesterId: oid(),
        departmentId: oid(),
        requestType: 'PURCHASE',
        title: 'Laptop Purchase',
        amount: null,
      },
      false
    );
    record('8. Purchase without amount rejected', r.ok, r.errors || '');
  }

  // Purchase with zero amount — must fail
  {
    const r = await validateDoc(
      Request,
      {
        organizationId: oid(),
        requesterId: oid(),
        departmentId: oid(),
        requestType: 'PURCHASE',
        title: 'Zero amount',
        amount: 0,
      },
      false
    );
    record('8b. Purchase with amount 0 rejected', r.ok, r.errors || '');
  }

  // Non-purchase without amount — should pass
  {
    const r = await validateDoc(
      Request,
      {
        organizationId: oid(),
        requesterId: oid(),
        departmentId: oid(),
        requestType: 'LEAVE',
        title: 'Annual Leave',
        amount: null,
      },
      true
    );
    record('8c. Leave request without amount accepted', r.ok, r.errors || '');
  }

  // 9. Valid approval step
  {
    const r = await validateDoc(
      ApprovalStep,
      {
        organizationId: oid(),
        requestId: oid(),
        attemptNumber: 1,
        sequence: 1,
        stageName: 'Department Manager Approval',
        approverType: 'DEPARTMENT_MANAGER',
        approverId: oid(),
        roleId: null,
        status: 'PENDING',
      },
      true
    );
    record('9. Valid approval step', r.ok, r.errors || '');
  }

  // 10. Valid workflow definition with stages
  {
    const r = await validateDoc(
      WorkflowDefinition,
      {
        organizationId: oid(),
        name: 'Purchase Workflow',
        requestType: 'PURCHASE',
        version: 1,
        stages: [
          {
            sequence: 1,
            name: 'Department Manager Approval',
            approverType: 'DEPARTMENT_MANAGER',
            roleId: null,
            condition: {
              field: 'amount',
              operator: 'GREATER_THAN',
              value: 50000,
            },
          },
        ],
        isActive: true,
        createdBy: oid(),
      },
      true
    );
    record('10. Valid workflow definition', r.ok, r.errors || '');
  }

  // Workflow without stages — must fail
  {
    const r = await validateDoc(
      WorkflowDefinition,
      {
        organizationId: oid(),
        name: 'Empty',
        requestType: 'GENERAL',
        version: 1,
        stages: [],
        createdBy: oid(),
      },
      false
    );
    record('10b. Workflow without stages rejected', r.ok, r.errors || '');
  }

  // 11. Valid audit log
  {
    const r = await validateDoc(
      AuditLog,
      {
        organizationId: oid(),
        actorId: oid(),
        action: 'USER_CREATED',
        resourceType: 'User',
        resourceId: oid(),
        changes: { name: 'Jane' },
      },
      true
    );
    record('11. Valid audit log', r.ok, r.errors || '');
  }

  // Platform-level audit log (null organizationId)
  {
    const r = await validateDoc(
      AuditLog,
      {
        organizationId: null,
        actorId: oid(),
        action: 'ORG_CREATED',
        resourceType: 'Organization',
        resourceId: oid(),
      },
      true
    );
    record('11b. Platform-level audit log', r.ok, r.errors || '');
  }

  // 12. Valid session
  {
    const r = await validateDoc(
      Session,
      {
        userId: oid(),
        organizationId: oid(),
        refreshTokenHash: 'abc123hashedtoken',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        revokedAt: null,
        lastUsedAt: new Date(),
      },
      true
    );
    record('12. Valid session', r.ok, r.errors || '');
  }

  // Session without refreshTokenHash — must fail
  {
    const r = await validateDoc(
      Session,
      {
        userId: oid(),
        expiresAt: new Date(),
      },
      false
    );
    record('12b. Session without refreshTokenHash rejected', r.ok, r.errors || '');
  }

  // Session schema should not persist updatedAt
  {
    const doc = new Session({
      userId: oid(),
      refreshTokenHash: 'hash-value',
      expiresAt: new Date(Date.now() + 1000),
    });
    const hasUpdatedAtPath = Object.prototype.hasOwnProperty.call(doc.toObject(), 'updatedAt');
    record('12c. Session does not define updatedAt', !hasUpdatedAtPath, hasUpdatedAtPath ? 'updatedAt present' : 'updatedAt absent');
  }

  // Audit log append-only enforcement
  {
    let blocked = false;
    try {
      await AuditLog.updateOne({ _id: oid() }, { $set: { action: 'MUTATED' } });
    } catch (error) {
      blocked = error.message.includes('append-only');
    }
    record('11c. AuditLog updateOne blocked (append-only)', blocked);
  }

  {
    let blocked = false;
    try {
      await AuditLog.deleteOne({ _id: oid() });
    } catch (error) {
      blocked = error.message.includes('append-only');
    }
    record('11d. AuditLog deleteOne blocked (append-only)', blocked);
  }

  // Workflow unique version index present after sync
  {
    const indexes = await db.collection('workflowDefinitions').indexes();
    const hasVersionUnique = indexes.some(
      (i) =>
        i.unique &&
        JSON.stringify(i.key) === JSON.stringify({ organizationId: 1, name: 1, version: 1 })
    );
    record('workflowDefinitions unique version index', hasVersionUnique);
  }

  // Idempotency: run initialize again
  console.log('\n=== Initialization idempotency ===');
  const before = (await db.listCollections().toArray()).map((c) => c.name).sort().join(',');
  await initializeDatabase();
  const after = (await db.listCollections().toArray()).map((c) => c.name).sort().join(',');
  record('initializeDatabase idempotent', before === after, `before=${before} after=${after}`);

  // Env secrets different
  record(
    'JWT secrets are different',
    env.JWT_ACCESS_SECRET !== env.JWT_REFRESH_SECRET,
    env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET ? 'secrets are identical' : 'secrets differ'
  );

  console.log('\n=== SUMMARY ===');
  const failed = results.filter((r) => !r.ok);
  console.log(`Total: ${results.length}, Passed: ${results.length - failed.length}, Failed: ${failed.length}`);
  if (failed.length) {
    console.log('Failures:');
    failed.forEach((f) => console.log(` - ${f.name}: ${f.detail}`));
  }

  process.emitWarning = originalEmitWarning;
  await mongoose.disconnect();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (error) => {
  console.error('Audit script failed:', error);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
