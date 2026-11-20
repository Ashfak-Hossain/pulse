-- Custom migration, written by hand: campus admins now create terms and activate them
-- (draft → active, active → archived). Migration 0011 made term read-only for pulse_app; this
-- gives back insert, and update of status only, so a term's name and dates never change after
-- the timetable is imported against them. Still no delete: sections point at terms
GRANT INSERT ON term TO pulse_app;
--> statement-breakpoint
GRANT UPDATE (status) ON term TO pulse_app;
