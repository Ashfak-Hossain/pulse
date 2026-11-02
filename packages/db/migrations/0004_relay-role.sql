-- Custom migration, written by hand: rights for the outbox relay's role and a guard on new
-- outbox rows. The relay reads every outbox row and marks it published or failed. It cannot add,
-- delete or change an event, and it sees no other table.
-- pulse_relay comes from infra/compose/postgres/init/02-relay-role.sql, which only runs on an
-- empty volume; stop here with a clear message instead of a vague GRANT error
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pulse_relay') THEN
    RAISE EXCEPTION 'role pulse_relay is missing: run infra/compose/postgres/init/02-relay-role.sql, or pnpm infra:reset';
  END IF;
END;
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO pulse_relay;
--> statement-breakpoint
GRANT SELECT ON outbox_event TO pulse_relay;
--> statement-breakpoint
GRANT UPDATE (published_at, attempts, last_error) ON outbox_event TO pulse_relay;
--> statement-breakpoint
-- A new row must start unpublished: a row inserted with published_at set would never be sent.
-- A trigger, not column grants: Drizzle lists every column in an INSERT, and PostgreSQL wants
-- INSERT rights on each listed column even for DEFAULT. Holds for every role, the owner too
CREATE FUNCTION outbox_event_starts_unpublished() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.published_at IS NOT NULL OR NEW.attempts <> 0 OR NEW.last_error IS NOT NULL THEN
    RAISE EXCEPTION 'a new outbox event must start unpublished'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER outbox_event_starts_unpublished
  BEFORE INSERT ON outbox_event
  FOR EACH ROW EXECUTE FUNCTION outbox_event_starts_unpublished();
