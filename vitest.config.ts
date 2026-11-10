import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'node', environment: 'node', include: ['app/shared/src/**/*.test.ts', 'app/server/src/**/*.test.ts'] } },
      { plugins: [react()], test: { name: 'db', environment: 'node', include: ['app/server/src/**/*.itest.ts'], fileParallelism: false, testTimeout: 30000, hookTimeout: 60000 } },
      { plugins: [react()], test: { name: 'web', environment: 'jsdom', include: ['app/web/src/**/*.test.{ts,tsx}'], setupFiles: ['app/web/src/test/setup-dom.ts'], testTimeout: 20000 } },
    ],
  },
});
