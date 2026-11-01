import { defineConfig } from 'vitest/config';

// Integration tests run against a real Kafka in a container (test/**/*.int.test.ts)
export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.int.test.ts'],
    globalSetup: ['test/support/global-setup.ts'],
    // Joining a consumer group on a slow CI runner can take longer than the 5 s default
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
