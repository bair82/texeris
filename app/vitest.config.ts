import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // node:sqlite and Electron-adjacent service tests shut down reliably in
    // child processes. The default worker-thread pool has intermittently
    // completed the tests without exiting on this desktop environment.
    pool: 'forks',
  },
});
