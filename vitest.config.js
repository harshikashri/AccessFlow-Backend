import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setupEnv.js'],
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
