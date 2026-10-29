-- drizzle-kit 0.31 drops the SRID from geometry columns; 4326 added by hand (test: migrations.int)
CREATE TABLE "campus" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"email_domains" text[] NOT NULL,
	"location" geometry(point, 4326) NOT NULL,
	"timezone" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campus_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "campus" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "outbox_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "outbox_event_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"aggregate" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "processed_event" (
	"consumer" text NOT NULL,
	"event_id" uuid NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_event_consumer_event_id_pk" PRIMARY KEY("consumer","event_id")
);
--> statement-breakpoint
CREATE INDEX "outbox_event_unpublished_idx" ON "outbox_event" USING btree ("seq") WHERE published_at is null;--> statement-breakpoint
CREATE POLICY "campus_read" ON "campus" AS PERMISSIVE FOR SELECT TO "pulse_app" USING (true);--> statement-breakpoint
CREATE POLICY "campus_insert" ON "campus" AS PERMISSIVE FOR INSERT TO "pulse_app" WITH CHECK (id = nullif(current_setting('app.campus_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "campus_update" ON "campus" AS PERMISSIVE FOR UPDATE TO "pulse_app" USING (id = nullif(current_setting('app.campus_id', true), '')::uuid) WITH CHECK (id = nullif(current_setting('app.campus_id', true), '')::uuid);
