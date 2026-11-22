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
--> statement-breakpoint
-- The status grant is only for finishing onboarding. Without this a buggy query could set a
-- suspended user back to active, and sign-in would let them in again. Suspension and deletion
-- stay with the owner until an admin endpoint widens this rule in its own migration
CREATE FUNCTION app_user_status_by_app() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF current_user = 'pulse_app'
    AND NEW.status IS DISTINCT FROM OLD.status
    AND (OLD.status, NEW.status) IS DISTINCT FROM ('pending_profile', 'active') THEN
    RAISE EXCEPTION 'pulse_app may only move app_user.status from pending_profile to active'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER app_user_status_by_app BEFORE UPDATE ON app_user
FOR EACH ROW EXECUTE FUNCTION app_user_status_by_app();
--> statement-breakpoint
-- Vehicles are only hidden (trips will point at them), and a trusted contact is replaced by
-- removing it and adding a new one, so the app needs neither of these
REVOKE DELETE ON vehicle FROM pulse_app;
--> statement-breakpoint
REVOKE UPDATE ON trusted_contact FROM pulse_app;
