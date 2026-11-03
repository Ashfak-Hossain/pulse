CREATE TABLE "course" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campus_id" uuid NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_campus_code_unique" UNIQUE("campus_id","code")
);
--> statement-breakpoint
ALTER TABLE "course" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "course" ADD CONSTRAINT "course_campus_id_campus_id_fk" FOREIGN KEY ("campus_id") REFERENCES "public"."campus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "course_read" ON "course" AS PERMISSIVE FOR SELECT TO "pulse_app" USING ("course"."campus_id" = nullif(current_setting('app.campus_id', true), '')::uuid);