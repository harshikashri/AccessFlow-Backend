import mongoose from 'mongoose';
import { AppError } from './AppError.js';

const isTransactionInfrastructureError = (error) => {
  const message = error?.message || '';
  return (
    error?.code === 20 ||
    error?.codeName === 'IllegalOperation' ||
    /Transaction numbers are only allowed/i.test(message) ||
    /replica set member or mongos/i.test(message) ||
    /not supported.*transaction/i.test(message)
  );
};

export const mapTransactionError = (error) => {
  if (isTransactionInfrastructureError(error)) {
    return new AppError(
      'This operation requires MongoDB replica-set transactions. Convert the local MongoDB instance to a single-node replica set.',
      500,
      'TRANSACTIONS_UNAVAILABLE'
    );
  }
  return error;
};

export const withTransaction = async (work) => {
  let session;
  try {
    session = await mongoose.startSession();
  } catch (error) {
    throw mapTransactionError(error);
  }

  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } catch (error) {
    throw mapTransactionError(error);
  } finally {
    await session.endSession();
  }
};

export default withTransaction;
