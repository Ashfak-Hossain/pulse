-- Custom migration, written by hand: what pulse_app may change on app_user and email_otp, and
-- their triggers. The app never deletes: accounts are soft-deleted, and old codes will be
-- purged by the table owner or a retention job (future slice). It never updates app_user:
-- sign-in only inserts, and later slices grant the column they change with their endpoint.
-- On email_otp it may only count a wrong try and mark a code used.
REVOKE DELETE, UPDATE ON app_user, email_otp FROM pulse_app;
--> statement-breakpoint
GRANT UPDATE (attempts, consumed_at) ON email_otp TO pulse_app;
--> statement-breakpoint
-- The grant still lets a buggy UPDATE reset attempts (unlimited guesses) or clear consumed_at
-- (a used code works again). This makes both one-way, for every writer
CREATE FUNCTION email_otp_one_way() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'email_otp.attempts can only go up' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    RAISE EXCEPTION 'email_otp.consumed_at is set once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER email_otp_one_way BEFORE UPDATE ON email_otp
FOR EACH ROW EXECUTE FUNCTION email_otp_one_way();
--> statement-breakpoint
-- Same trigger as term and section (migration 0012): updated_at changes only when a column did
CREATE TRIGGER app_user_set_updated_at BEFORE UPDATE ON app_user
FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
