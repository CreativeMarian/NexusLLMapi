import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/.tmp/**', 'node_modules/**'],
    testTimeout: 90000,
    hookTimeout: 60000,
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
  },
});
