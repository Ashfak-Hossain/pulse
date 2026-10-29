-- Custom migration, written by hand: things drizzle-kit cannot express in src/schema.ts.
-- Runs before the tables, because campus.location needs the PostGIS geometry type.
CREATE EXTENSION IF NOT EXISTS postgis;
--> statement-breakpoint
-- pulse_app (created by infra/compose/postgres/init) may use the schema but create nothing in it
GRANT USAGE ON SCHEMA public TO pulse_app;
--> statement-breakpoint
-- Every table the migration owner creates from now on is readable and writable by the app,
-- so no later migration can forget the grant. Row-level security still filters the rows
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pulse_app;
--> statement-breakpoint
-- The same for sequences, for future serial columns and explicit nextval(). Identity columns
-- such as outbox_event.seq need no sequence privilege to insert
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO pulse_app;
