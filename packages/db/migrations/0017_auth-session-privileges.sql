-- Custom migration, written by hand: what pulse_app may do to auth_session, and its guard
-- trigger. Refresh marks a row rotated; sign-out, reuse detection and suspension revoke rows.
-- Nothing else about a session changes after insert. The app never deletes: a revoked row stays
-- as the record of why, and the retention job will purge old rows as the owner (future slice).
REVOKE DELETE, UPDATE ON auth_session FROM pulse_app;
--> statement-breakpoint
GRANT UPDATE (rotated_at, revoked_at, revoke_reason) ON auth_session TO pulse_app;
--> statement-breakpoint
-- The grant alone still lets a buggy UPDATE un-revoke a session or clear rotated_at (a stolen
-- token works again), and lets an INSERT choose created_at (stretching the 30-day CHECK). So
-- the database sets these times itself, and each lifecycle step happens once, for every writer
CREATE FUNCTION auth_session_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A session starts live; rotation and revocation only ever come later, by UPDATE
    IF NEW.rotated_at IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'a new auth_session starts live' USING ERRCODE = 'check_violation';
    END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF OLD.rotated_at IS NOT NULL AND NEW.rotated_at IS DISTINCT FROM OLD.rotated_at THEN
    RAISE EXCEPTION 'auth_session.rotated_at is set once' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.revoked_at IS NOT NULL
    AND (NEW.revoked_at, NEW.revoke_reason) IS DISTINCT FROM (OLD.revoked_at, OLD.revoke_reason) THEN
    RAISE EXCEPTION 'auth_session revocation is final' USING ERRCODE = 'check_violation';
  END IF;
  -- A future rotated_at would keep the reuse grace window open forever
  IF OLD.rotated_at IS NULL AND NEW.rotated_at IS NOT NULL THEN
    NEW.rotated_at := now();
  END IF;
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    NEW.revoked_at := now();
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER auth_session_guard BEFORE INSERT OR UPDATE ON auth_session
FOR EACH ROW EXECUTE FUNCTION auth_session_guard();
