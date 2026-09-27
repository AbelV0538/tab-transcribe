import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative asset URLs so the same build works from a sub-path, file server or native wrapper.
  base: './',
  worker: { format: 'es' },
  build: {
    target: 'es2020',
    outDir: 'dist',
    chunkSizeWarningLimit: 2500,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/**/*.model.test.ts', 'tests/**/*.e2e.test.ts', 'node_modules/**'],
    environment: 'node',
  },
});
