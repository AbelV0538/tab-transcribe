import { defineConfig } from 'vitest/config';

// Benchmarks on the RTYWD album (tabs + recordings, not in git). Skipped when the files are absent.
export default defineConfig({
  test: {
    include: ['tests/**/*.album.test.ts'],
    environment: 'node',
    testTimeout: 3_600_000,
    hookTimeout: 3_600_000,
    reporters: ['verbose'],
  },
});
