import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src/', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    // The integration suites share a single Postgres DB; running test files in
    // parallel triggers TRUNCATE-vs-INSERT races (and even Postgres deadlocks)
    // between unrelated suites. Force sequential file execution.
    fileParallelism: false,
    // Keep pino quiet in tests so output stays clean.
    env: { LOG_LEVEL: 'silent', NODE_ENV: 'test', STORAGE_DRIVER: 'memory' },
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/index.ts', 'src/worker.ts'],
    },
  },
});
