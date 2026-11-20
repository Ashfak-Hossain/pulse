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
