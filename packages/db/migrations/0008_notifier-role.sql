-- Custom migration, written by hand: rights for the notifier's role. The notifier records each
-- event it handled in processed_event, in the same transaction as its work. It cannot change or
-- erase a record (that would let a redelivered event run twice), and it sees no other app table.
-- pulse_notifier comes from infra/compose/postgres/init/03-notifier-role.sql, which only runs on
-- an empty volume; stop here with a clear message instead of a vague GRANT error
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pulse_notifier') THEN
    RAISE EXCEPTION 'role pulse_notifier is missing: run infra/compose/postgres/init/03-notifier-role.sql, or pnpm infra:reset';
  END IF;
END;
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO pulse_notifier;
--> statement-breakpoint
-- SELECT for RETURNING: an insert that returns no row tells the consumer the event is a repeat
GRANT SELECT, INSERT ON processed_event TO pulse_notifier;
--> statement-breakpoint
-- The API handles no events. Its default grants (migration 0000) gave it these; 0002 already
-- took UPDATE and DELETE
REVOKE SELECT, INSERT ON processed_event FROM pulse_app;
