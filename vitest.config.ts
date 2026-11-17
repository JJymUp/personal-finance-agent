import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: {
    host: '127.0.0.1',
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
