ALTER TABLE "outbox_event" ADD COLUMN "version" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_event" ADD COLUMN "topic" text NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_event" ADD COLUMN "key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_event" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_event" ADD COLUMN "last_error" text;