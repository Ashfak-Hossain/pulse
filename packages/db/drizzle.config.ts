import { defineConfig } from 'drizzle-kit';

// drizzle-kit only: `db:generate` diffs src/schema.ts against migrations/, `db:migrate` applies them.
// Migrations run as the table owner; the app itself connects as pulse_app
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  // check-migrations.sh points this at a scratch copy, so it can diff with this exact config
  out: process.env.DRIZZLE_OUT ?? './migrations',
  dbCredentials: {
    // Falls back to the throwaway Compose defaults, so local runs need no env file
    url: process.env.MIGRATION_DATABASE_URL ?? 'postgres://pulse:pulse@127.0.0.1:5432/pulse',
  },
});
