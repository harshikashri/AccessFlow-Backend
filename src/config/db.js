import mongoose from 'mongoose';
import { env } from './env.js';

import Organization from '../models/Organization.js';
import Department from '../models/Department.js';
import User from '../models/User.js';
import Role from '../models/Role.js';
import UserRoleAssignment from '../models/UserRoleAssignment.js';
import Request from '../models/Request.js';
import ApprovalStep from '../models/ApprovalStep.js';
import WorkflowDefinition from '../models/WorkflowDefinition.js';
import AuditLog from '../models/AuditLog.js';
import Session from '../models/Session.js';

const REQUIRED_COLLECTIONS = [
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

const registeredModels = {
  Organization,
  Department,
  User,
  Role,
  UserRoleAssignment,
  Request,
  ApprovalStep,
  WorkflowDefinition,
  AuditLog,
  Session,
};

let listenersRegistered = false;

const registerConnectionListeners = () => {
  if (listenersRegistered) {
    return;
  }

  mongoose.connection.on('connected', () => {
    console.log('MongoDB connected successfully.');
  });

  mongoose.connection.on('error', (error) => {
    console.error('MongoDB connection error:', error.message);
  });

  mongoose.connection.on('disconnected', () => {
    console.warn('MongoDB disconnected.');
  });

  listenersRegistered = true;
};

export const connectDatabase = async () => {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  registerConnectionListeners();

  try {
    await mongoose.connect(env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
    });

    return mongoose.connection;
  } catch (error) {
    console.error('Failed to connect to MongoDB:', error.message);
    throw error;
  }
};

export const initializeDatabase = async () => {
  await connectDatabase();

  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('MongoDB connection is not available.');
  }

  for (const collectionName of REQUIRED_COLLECTIONS) {
    const exists = await db.listCollections({ name: collectionName }).hasNext();
    if (!exists) {
      await db.createCollection(collectionName);
      console.log(`Created collection: ${collectionName}`);
    }
  }

  for (const model of Object.values(registeredModels).filter((candidate) => candidate !== Role)) {
    await model.syncIndexes();
  }

  return {
    collections: REQUIRED_COLLECTIONS,
    models: Object.keys(registeredModels),
  };
};

export default connectDatabase;
