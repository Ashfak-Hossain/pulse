-- Runs once on an empty data volume (Compose) and on every test container start.
-- The notifier (a Kafka consumer in apps/worker) connects as pulse_notifier: it records handled
-- events in processed_event and nothing else (grants in migration 0008). Owns no tables, so it
-- gains no hidden rights. The password is a throwaway local default.
CREATE ROLE pulse_notifier LOGIN PASSWORD 'pulse_notifier' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
