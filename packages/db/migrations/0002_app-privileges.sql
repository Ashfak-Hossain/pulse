-- Custom migration, written by hand: take back rights the default grants gave pulse_app.
-- The API may only add outbox events: outbox_event has no RLS, so SELECT would show every
-- campus's payloads, and UPDATE or DELETE could lose events. Reading and marking them published
-- belongs to the relay's own role.
REVOKE SELECT, UPDATE, DELETE ON outbox_event FROM pulse_app;
--> statement-breakpoint
-- Consumers record and check processed events but never change or remove them:
-- a deleted row would let the same event run twice.
REVOKE UPDATE, DELETE ON processed_event FROM pulse_app;
--> statement-breakpoint
-- The outbox counter's value is the total number of events of every campus, and the app never
-- needs it: inserts fill an identity column without any sequence privilege
REVOKE ALL ON SEQUENCE outbox_event_seq_seq FROM pulse_app;
--> statement-breakpoint
-- No request deletes a campus: it would take the whole tenant with it. That is an owner/admin
-- job, so pulse_app keeps SELECT, INSERT and UPDATE on campus only
REVOKE DELETE ON campus FROM pulse_app;
