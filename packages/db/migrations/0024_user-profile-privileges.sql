-- Custom migration, written by hand: what pulse_app may change on app_user, and the updated_at
-- triggers of the new tables. Migration 0015 gave pulse_app no UPDATE on app_user on purpose;
-- PATCH /me now needs the profile fields and the pending_profile → active step. Only these
-- columns: email, role and campus_id stay out of the app's reach, so no bug in a profile
-- endpoint can change who a user is, what they may do or which campus they belong to
GRANT UPDATE (first_name, last_name, gender, department, phone_e164, status) ON app_user TO pulse_app;
--> statement-breakpoint
-- Same trigger as term and section (migration 0012): updated_at changes only when a column did
CREATE TRIGGER preference_set_updated_at BEFORE UPDATE ON preference
FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER vehicle_set_updated_at BEFORE UPDATE ON vehicle
FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
