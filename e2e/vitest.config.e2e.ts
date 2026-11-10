import { defineConfig } from 'vitest/config';

// Runs the built API and worker (apps/*/dist/main.js) against throwaway containers. The
// @pulse/api and @pulse/worker devDependencies make turbo build both before this runs
export default defineConfig({
  test: {
    globals: true,
    include: ['*.e2e.test.ts'],
    globalSetup: ['support/global-setup.ts'],
    // One email crosses two programs and four services; a slow CI runner needs the room
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
