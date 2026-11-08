-- Custom migration, written by hand: PostgreSQL keeps updated_at current, so no writer
-- (importer, admin script, psql) can forget it. Rows rewritten unchanged keep their old time.
CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER term_set_updated_at BEFORE UPDATE ON term
FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER section_set_updated_at BEFORE UPDATE ON section
FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
