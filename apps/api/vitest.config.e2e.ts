import { defineConfig } from 'vitest/config';

// End-to-end tests start the whole app and call it over HTTP (test/**/*.e2e-spec.ts)
export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.e2e-spec.ts'],
    // ConfigModule validates the env at startup; the tests swap the database for a fake,
    // so this URL only has to be well formed (port 1: nothing ever listens there)
    env: { DATABASE_URL: 'postgres://pulse_app:unused@127.0.0.1:1/pulse' },
  },
});
