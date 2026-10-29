import { defineConfig } from 'vitest/config';

// End-to-end tests start the whole app and call it over HTTP (test/**/*.e2e-spec.ts)
export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.e2e-spec.ts'],
  },
});
