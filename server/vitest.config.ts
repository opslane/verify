import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: true, // DB integration tests must run sequentially
      },
    },
    sequence: {
      // Run migrate before db tests so schema is ready
      setupFiles: [],
    },
  },
});
