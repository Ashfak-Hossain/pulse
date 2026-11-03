-- Owner-only writes for the onboarding catalog. RLS limits SELECT to withCampus().
-- Default privileges grant DML on new tables, so explicitly revoke every write operation.
REVOKE INSERT, UPDATE, DELETE ON TABLE course FROM pulse_app;
