-- Custom migration, written by hand: audit_log is append-only, and the place tables keep
-- updated_at current. The policies already give pulse_app only select and insert on audit_log;
-- taking away the grants as well means a later policy can never open updates or deletes by mistake
REVOKE UPDATE, DELETE ON audit_log FROM pulse_app;
--> statement-breakpoint
-- Same trigger as term and section (migration 0012): updated_at changes only when a column did
CREATE TRIGGER campus_gate_set_updated_at BEFORE UPDATE ON campus_gate
FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER zone_set_updated_at BEFORE UPDATE ON zone
FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER meeting_point_set_updated_at BEFORE UPDATE ON meeting_point
FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- The API only hides a meeting point (is_active = false): trips will point at it later, so no
-- bug in the app may ever delete one
REVOKE DELETE ON meeting_point FROM pulse_app;
--> statement-breakpoint
-- An append-only trail is only worth something if its times are true: the database stamps `at`
-- itself, so no writer can backdate or postdate an audit row
CREATE FUNCTION audit_log_stamp_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  NEW.at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_stamp_at BEFORE INSERT ON audit_log
FOR EACH ROW EXECUTE FUNCTION audit_log_stamp_at();
