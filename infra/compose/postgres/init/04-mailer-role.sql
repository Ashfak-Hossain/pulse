-- Runs once on an empty data volume (Compose) and on every test container start.
-- The email worker (apps/worker, mailer) connects as pulse_mailer: it claims and marks rows in
-- email_delivery and reads a campus's id and name (grants in migration 0013). Owns no tables, so
-- it gains no hidden rights. The password is a throwaway local default.
CREATE ROLE pulse_mailer LOGIN PASSWORD 'pulse_mailer' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
