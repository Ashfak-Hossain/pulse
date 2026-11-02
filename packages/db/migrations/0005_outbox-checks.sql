ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_version_positive" CHECK ("outbox_event"."version" > 0);--> statement-breakpoint
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_topic_not_empty" CHECK ("outbox_event"."topic" <> '');--> statement-breakpoint
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_key_not_empty" CHECK ("outbox_event"."key" <> '');--> statement-breakpoint
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_attempts_not_negative" CHECK ("outbox_event"."attempts" >= 0);