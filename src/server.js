import app from './app.js';
import { env } from './config/env.js';
import { connectDatabase, initializeDatabase } from './config/db.js';

const startServer = async () => {
  try {
    await connectDatabase();
    await initializeDatabase();

    app.listen(env.PORT, () => {
      console.log(`AccessFlow backend listening on port ${env.PORT}`);
    });
  } catch (error) {
    console.error('Unable to start AccessFlow backend:', error.message);
    process.exit(1);
  }
};

startServer();

export { startServer };
