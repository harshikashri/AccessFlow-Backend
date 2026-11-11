import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const assertTestDatabaseUri = (uri) => {
  const parsed = new URL(uri);
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  if (parsed.port === '27017' || databaseName !== 'accessflow_test') {
    throw new Error(`Refusing to run tests against unsafe MongoDB URI: ${uri}`);
  }
};

const verifyTransactionSupport = async (uri) => {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  const collectionName = `phase4_smoke_${randomUUID().replaceAll('-', '')}`;
  let session;
  try {
    await client.connect();
    const admin = client.db('admin');
    const status = await admin.command({ replSetGetStatus: 1 });
    if (status.members.filter((member) => member.stateStr === 'PRIMARY').length !== 1) {
      throw new Error('The isolated MongoDB replica set has no PRIMARY.');
    }

    const db = client.db('accessflow_test');
    await db.createCollection(collectionName);
    const collection = db.collection(collectionName);
    session = client.startSession();
    await session.withTransaction(async () => {
      await collection.insertOne({ _id: 'commit-check' }, { session });
    });

    try {
      await session.withTransaction(async () => {
        await collection.insertOne({ _id: 'rollback-check' }, { session });
        throw new Error('Expected transaction abort.');
      });
    } catch (error) {
      if (error.message !== 'Expected transaction abort.') throw error;
    }

    const [committed, rolledBack] = await Promise.all([
      collection.countDocuments({ _id: 'commit-check' }),
      collection.countDocuments({ _id: 'rollback-check' }),
    ]);
    if (committed !== 1 || rolledBack !== 0) {
      throw new Error('MongoDB transaction commit/rollback smoke test failed.');
    }
  } finally {
    if (session) await session.endSession();
    await client.db('accessflow_test').collection(collectionName).drop().catch((error) => {
      if (error.codeName !== 'NamespaceNotFound') throw error;
    });
    await client.close();
  }
};

const verifyApplicationCollections = async (uri) => {
  const expected = [
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
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  try {
    await client.connect();
    const names = (await client.db('accessflow_test').listCollections({}, { nameOnly: true }).toArray())
      .map((collection) => collection.name)
      .sort();
    if (JSON.stringify(names) !== JSON.stringify([...expected].sort())) {
      throw new Error(`Expected exactly 10 application collections, found: ${names.join(', ')}`);
    }
  } finally {
    await client.close();
  }
};

export default async function setup(project) {
  const replicaSet = await MongoMemoryReplSet.create({
    binary: { version: '7.0.14' },
    replSet: { count: 1, name: 'rsTest', storageEngine: 'wiredTiger' },
  });
  const uri = replicaSet.getUri('accessflow_test');

  try {
    assertTestDatabaseUri(uri);
    await verifyTransactionSupport(uri);
  } catch (error) {
    await replicaSet.stop();
    throw error;
  }

  project.provide('accessflowMongoUri', uri);
  return async () => {
    try {
      await verifyApplicationCollections(uri);
    } finally {
      await replicaSet.stop();
    }
  };
}
