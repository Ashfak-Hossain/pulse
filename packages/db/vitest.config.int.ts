import { defineConfig } from 'vitest/config';

// Integration tests run against a real PostGIS in a container (test/**/*.int.test.ts)
export default defineConfig({
  test: {
    include: ['test/**/*.int.test.ts'],
    globalSetup: ['test/support/global-setup.ts'],
  },
});
