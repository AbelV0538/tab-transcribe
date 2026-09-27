import { defineConfig } from 'vitest/config';

// End-to-end tests that run the real neural model on synthesised audio (slower).
export default defineConfig({
  test: {
    include: ['tests/**/*.model.test.ts'],
    environment: 'node',
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
