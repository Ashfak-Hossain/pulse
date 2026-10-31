import { defineConfig } from 'vitest/config';

// End-to-end tests start the whole app and call it over HTTP (test/**/*.e2e-spec.ts)
export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.e2e-spec.ts'],
    // Starts one PostGIS container for the run (campus tests read a real database)
    globalSetup: ['test/support/global-setup.ts'],
    // ConfigModule validates the env at startup; every test swaps the database (a fake or the
    // container), so this URL only has to be well formed (port 1: nothing ever listens there)
    env: { DATABASE_URL: 'postgres://pulse_app:unused@127.0.0.1:1/pulse' },
  },
});
