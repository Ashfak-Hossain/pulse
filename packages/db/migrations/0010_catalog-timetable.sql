-- The existing course table needs its composite key before the new section FK.
ALTER TABLE "course" ADD CONSTRAINT "course_id_campus_unique" UNIQUE("id","campus_id");--> statement-breakpoint
CREATE TABLE "section" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"campus_id" uuid NOT NULL,
	"term_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"external_class_id" text NOT NULL,
	"section_label" text NOT NULL,
	"title" text NOT NULL,
	"capacity" smallint NOT NULL,
	"enrolled" smallint NOT NULL,
	"status" text NOT NULL,
	"instructor_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "section_id_campus_unique" UNIQUE("id","campus_id"),
	CONSTRAINT "section_term_external_class_unique" UNIQUE("term_id","external_class_id"),
	CONSTRAINT "section_capacity_nonnegative" CHECK ("section"."capacity" >= 0),
	CONSTRAINT "section_enrolled_nonnegative" CHECK ("section"."enrolled" >= 0),
	CONSTRAINT "section_status_valid" CHECK ("section"."status" in ('open', 'reserved', 'freshman', 'closed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "section" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "section_meeting" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"campus_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"weekday" smallint NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"room" text,
	CONSTRAINT "section_meeting_kind_valid" CHECK ("section_meeting"."kind" in ('theory', 'lab', 'other')),
	CONSTRAINT "section_meeting_weekday_valid" CHECK ("section_meeting"."weekday" between 0 and 6),
	CONSTRAINT "section_meeting_times_ordered" CHECK ("section_meeting"."end_time" > "section_meeting"."start_time")
);
--> statement-breakpoint
ALTER TABLE "section_meeting" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "term" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"campus_id" uuid NOT NULL,
	"name" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "term_id_campus_unique" UNIQUE("id","campus_id"),
	CONSTRAINT "term_campus_name_unique" UNIQUE("campus_id","name"),
	CONSTRAINT "term_dates_ordered" CHECK ("term"."ends_on" > "term"."starts_on"),
	CONSTRAINT "term_status_valid" CHECK ("term"."status" in ('draft', 'active', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "term" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "section" ADD CONSTRAINT "section_campus_id_campus_id_fk" FOREIGN KEY ("campus_id") REFERENCES "public"."campus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "section" ADD CONSTRAINT "section_term_campus_fk" FOREIGN KEY ("term_id","campus_id") REFERENCES "public"."term"("id","campus_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "section" ADD CONSTRAINT "section_course_campus_fk" FOREIGN KEY ("course_id","campus_id") REFERENCES "public"."course"("id","campus_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "section_meeting" ADD CONSTRAINT "section_meeting_campus_id_campus_id_fk" FOREIGN KEY ("campus_id") REFERENCES "public"."campus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "section_meeting" ADD CONSTRAINT "section_meeting_section_campus_fk" FOREIGN KEY ("section_id","campus_id") REFERENCES "public"."section"("id","campus_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term" ADD CONSTRAINT "term_campus_id_campus_id_fk" FOREIGN KEY ("campus_id") REFERENCES "public"."campus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "section_campus_idx" ON "section" USING btree ("campus_id");--> statement-breakpoint
CREATE INDEX "section_term_campus_idx" ON "section" USING btree ("term_id","campus_id");--> statement-breakpoint
CREATE INDEX "section_course_campus_idx" ON "section" USING btree ("course_id","campus_id");--> statement-breakpoint
CREATE INDEX "section_title_trgm_idx" ON "section" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "section_meeting_section_campus_idx" ON "section_meeting" USING btree ("section_id","campus_id");--> statement-breakpoint
CREATE INDEX "section_meeting_departure_idx" ON "section_meeting" USING btree ("campus_id","weekday","end_time");--> statement-breakpoint
CREATE UNIQUE INDEX "term_one_active_per_campus" ON "term" USING btree ("campus_id") WHERE "term"."status" = 'active';--> statement-breakpoint
CREATE INDEX "course_title_trgm_idx" ON "course" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE POLICY "section_read" ON "section" AS PERMISSIVE FOR SELECT TO "pulse_app" USING ("section"."campus_id" = nullif(current_setting('app.campus_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "section_meeting_read" ON "section_meeting" AS PERMISSIVE FOR SELECT TO "pulse_app" USING ("section_meeting"."campus_id" = nullif(current_setting('app.campus_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "term_read" ON "term" AS PERMISSIVE FOR SELECT TO "pulse_app" USING ("term"."campus_id" = nullif(current_setting('app.campus_id', true), '')::uuid);