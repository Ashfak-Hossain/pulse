CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"campus_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'student' NOT NULL,
	"status" text DEFAULT 'pending_profile' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_user_email_unique" UNIQUE("email"),
	CONSTRAINT "app_user_id_campus_unique" UNIQUE("id","campus_id"),
	CONSTRAINT "app_user_deleted_email_wiped" CHECK (("app_user"."status" = 'deleted') = ("app_user"."email" like 'deleted+%@invalid')),
	CONSTRAINT "app_user_email_lowercase" CHECK ("app_user"."email" = lower("app_user"."email")),
	CONSTRAINT "app_user_role_valid" CHECK ("app_user"."role" in ('student', 'faculty', 'staff', 'operator', 'campus_admin')),
	CONSTRAINT "app_user_status_valid" CHECK ("app_user"."status" in ('pending_profile', 'active', 'suspended', 'deleted'))
);
--> statement-breakpoint
ALTER TABLE "app_user" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "email_otp" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"campus_id" uuid NOT NULL,
	"email" text NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"ip_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_otp_email_lowercase" CHECK ("email_otp"."email" = lower("email_otp"."email")),
	CONSTRAINT "email_otp_code_hash_hex" CHECK ("email_otp"."code_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "email_otp_ip_hash_hex" CHECK ("email_otp"."ip_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "email_otp_attempts_range" CHECK ("email_otp"."attempts" between 0 and 5),
	CONSTRAINT "email_otp_expires_window" CHECK ("email_otp"."expires_at" > "email_otp"."created_at" and "email_otp"."expires_at" <= "email_otp"."created_at" + interval '15 minutes')
);
--> statement-breakpoint
ALTER TABLE "email_otp" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_campus_id_campus_id_fk" FOREIGN KEY ("campus_id") REFERENCES "public"."campus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_otp" ADD CONSTRAINT "email_otp_campus_id_campus_id_fk" FOREIGN KEY ("campus_id") REFERENCES "public"."campus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_user_campus_role_idx" ON "app_user" USING btree ("campus_id","role");--> statement-breakpoint
CREATE INDEX "email_otp_campus_email_created_idx" ON "email_otp" USING btree ("campus_id","email","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE POLICY "app_user_campus" ON "app_user" AS PERMISSIVE FOR ALL TO "pulse_app" USING ("app_user"."campus_id" = nullif(current_setting('app.campus_id', true), '')::uuid) WITH CHECK ("app_user"."campus_id" = nullif(current_setting('app.campus_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "email_otp_campus" ON "email_otp" AS PERMISSIVE FOR ALL TO "pulse_app" USING ("email_otp"."campus_id" = nullif(current_setting('app.campus_id', true), '')::uuid) WITH CHECK ("email_otp"."campus_id" = nullif(current_setting('app.campus_id', true), '')::uuid);