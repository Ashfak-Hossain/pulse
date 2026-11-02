-- Runs once on an empty data volume (Compose) and on every test container start.
-- The outbox relay connects as pulse_relay: it reads outbox_event and marks rows published or
-- failed, and nothing else (grants in migration 0004). Owns no tables, so it gains no hidden
-- rights. The password is a throwaway local default.
CREATE ROLE pulse_relay LOGIN PASSWORD 'pulse_relay' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
