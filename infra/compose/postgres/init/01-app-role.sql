-- Runs once on an empty data volume (Compose) and on every test container start.
-- The API connects as pulse_app: it owns no tables, so row-level security always applies to it.
-- Table grants come from the migrations. The password is a throwaway local default.
CREATE ROLE pulse_app LOGIN PASSWORD 'pulse_app' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
