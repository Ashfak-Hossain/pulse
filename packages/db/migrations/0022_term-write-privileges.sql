-- Custom migration, written by hand: campus admins now create terms and activate them
-- (draft → active, active → archived). Migration 0011 made term read-only for pulse_app; this
-- gives back insert, and update of status only, so a term's name and dates never change after
-- the timetable is imported against them. Still no delete: sections point at terms
GRANT INSERT ON term TO pulse_app;
--> statement-breakpoint
GRANT UPDATE (status) ON term TO pulse_app;
--> statement-breakpoint
-- The status grant alone would let a buggy UPDATE reopen an archived term or send an active one
-- back to draft, skipping the audit row and TermActivated. A term only ever moves forward:
-- draft → active → archived, for every writer
CREATE FUNCTION term_status_forward() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
    AND (OLD.status, NEW.status) NOT IN (('draft', 'active'), ('active', 'archived')) THEN
    RAISE EXCEPTION 'term.status can only move draft → active → archived'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER term_status_forward BEFORE UPDATE ON term
FOR EACH ROW EXECUTE FUNCTION term_status_forward();
