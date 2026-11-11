import app from './app.js';
import { env } from './config/env.js';
import { connectDatabase, initializeDatabase } from './config/db.js';
import { startApprovalMaintenanceWorker } from './modules/requests/approvalMaintenance.worker.js';
import { stopApprovalMaintenanceWorker } from './modules/requests/approvalMaintenance.worker.js';
import mongoose from 'mongoose';

let server;
let shuttingDown = false;

const startServer = async () => {
  try {
    await connectDatabase();
    await initializeDatabase();
    startApprovalMaintenanceWorker();

    server = app.listen(env.PORT, () => {
      console.log(`AccessFlow backend listening on port ${env.PORT}`);
    });
    return server;
  } catch (error) {
    console.error('Unable to start AccessFlow backend:', error.message);
    process.exit(1);
  }
};

const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await stopApprovalMaintenanceWorker();
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await mongoose.disconnect();
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

if (process.env.NODE_ENV !== 'test') startServer();

export { startServer, shutdown };
