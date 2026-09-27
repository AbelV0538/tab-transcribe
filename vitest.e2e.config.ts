import { defineConfig } from 'vitest/config';

// Browser end-to-end tests against the production build (`npm run build` first).
export default defineConfig({
  test: {
    include: ['tests/**/*.e2e.test.ts'],
    environment: 'node',
    testTimeout: 300_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
