import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Binds the in-process job runner so service tests run task code without
    // the built worker bundle.
    setupFiles: ['src/main/jobs/testSetup.ts'],
    // node:sqlite and Electron-adjacent service tests shut down reliably in
    // child processes. The default worker-thread pool has intermittently
    // completed the tests without exiting on this desktop environment.
    pool: 'forks',
  },
});
