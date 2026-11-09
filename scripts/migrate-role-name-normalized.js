import mongoose from 'mongoose';
import { connectDatabase } from '../src/config/db.js';
import Role from '../src/models/Role.js';

const OLD_INDEX = 'organizationId_1_name_1';
const NEW_INDEX = 'organizationId_1_nameNormalized_1';

const normalize = (name) => String(name).trim().toLocaleLowerCase('en-US');
const dryRun = process.argv.slice(2).includes('--dry-run');

const findDuplicates = async () => {
  const duplicates = await Role.aggregate([
    {
      $project: {
        organizationId: 1,
        name: 1,
        nameNormalized: { $toLower: { $trim: { input: '$name' } } },
      },
    },
    {
      $group: {
        _id: { organizationId: '$organizationId', nameNormalized: '$nameNormalized' },
        roles: { $push: { id: '$_id', name: '$name' } },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $sort: { '_id.organizationId': 1, '_id.nameNormalized': 1 } },
  ]);
  return duplicates;
};

const run = async () => {
  await connectDatabase();
  const duplicates = await findDuplicates();
  if (duplicates.length) {
    console.error('Role name migration stopped: case-insensitive duplicates were found.');
    for (const duplicate of duplicates) {
      console.error(JSON.stringify({
        organizationId: String(duplicate._id.organizationId),
        nameNormalized: duplicate._id.nameNormalized,
        roles: duplicate.roles.map((role) => ({ id: String(role.id), name: role.name })),
      }));
    }
    process.exitCode = 2;
    return;
  }

  const roles = await Role.find({}).select('_id organizationId name').lean();
  console.log(`${dryRun ? 'Would update' : 'Updating'} ${roles.length} role documents.`);
  if (dryRun) {
    console.log(`Would create unique index ${NEW_INDEX} and then remove ${OLD_INDEX} if present.`);
    return;
  }

  if (roles.length) {
    await Role.bulkWrite(
      roles.map((role) => ({
        updateOne: {
          filter: { _id: role._id },
          update: { $set: { nameNormalized: normalize(role.name) } },
        },
      }))
    );
  }

  await Role.collection.createIndex(
    { organizationId: 1, nameNormalized: 1 },
    { name: NEW_INDEX, unique: true }
  );
  const indexes = await Role.collection.indexes();
  if (!indexes.some((index) => index.name === NEW_INDEX && index.unique === true)) {
    throw new Error(`Unique index ${NEW_INDEX} could not be verified.`);
  }
  if (indexes.some((index) => index.name === OLD_INDEX)) {
    await Role.collection.dropIndex(OLD_INDEX);
  }
  console.log(`Created and verified ${NEW_INDEX}; removed ${OLD_INDEX} when present.`);
};

try {
  await run();
} finally {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}
