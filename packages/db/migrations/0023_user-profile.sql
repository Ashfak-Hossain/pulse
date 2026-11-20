CREATE TABLE "preference" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"campus_id" uuid NOT NULL,
	"home_cell" text NOT NULL,
	"zone_id" uuid,
	"gender_pref" text DEFAULT 'any' NOT NULL,
	"modes" text[] NOT NULL,
	"max_wait_min" smallint DEFAULT 10 NOT NULL,
	"max_detour_pct" smallint DEFAULT 30 NOT NULL,
	"autopilot_on" boolean DEFAULT false NOT NULL,
	"quiet_start_time" time,
	"quiet_end_time" time,
	"daily_notify_budget" smallint DEFAULT 6 NOT NULL,
	"share_text_for_training" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "preference_home_cell_h3" CHECK ("preference"."home_cell" ~ '^[0-9a-f]{15}$'),
	CONSTRAINT "preference_gender_pref_valid" CHECK ("preference"."gender_pref" in ('any', 'same_gender')),
	CONSTRAINT "preference_modes_valid" CHECK (cardinality("preference"."modes") > 0 and "preference"."modes" <@ array['cng', 'rickshaw', 'ride_hail_car', 'own_car', 'own_bike', 'bus', 'shuttle']::text[]),
	CONSTRAINT "preference_max_wait_range" CHECK ("preference"."max_wait_min" between 0 and 60),
	CONSTRAINT "preference_max_detour_range" CHECK ("preference"."max_detour_pct" between 0 and 50),
	CONSTRAINT "preference_quiet_hours_paired" CHECK (("preference"."quiet_start_time" is null) = ("preference"."quiet_end_time" is null)),
	CONSTRAINT "preference_notify_budget_range" CHECK ("preference"."daily_notify_budget" between 1 and 20)
);
--> statement-breakpoint
ALTER TABLE "preference" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "trusted_contact" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"campus_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"slot" smallint NOT NULL,
	"name" text NOT NULL,
	"phone_e164" text NOT NULL,
	"relation" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trusted_contact_user_slot_unique" UNIQUE("user_id","slot"),
	CONSTRAINT "trusted_contact_slot_range" CHECK ("trusted_contact"."slot" between 1 and 3),
	CONSTRAINT "trusted_contact_name_clean" CHECK ("trusted_contact"."name" = btrim("trusted_contact"."name") and length("trusted_contact"."name") between 1 and 100),
	CONSTRAINT "trusted_contact_phone_e164" CHECK ("trusted_contact"."phone_e164" ~ '^[+][1-9][0-9]{7,14}$'),
	CONSTRAINT "trusted_contact_relation_clean" CHECK ("trusted_contact"."relation" = btrim("trusted_contact"."relation") and length("trusted_contact"."relation") between 1 and 40)
);
--> statement-breakpoint
ALTER TABLE "trusted_contact" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "vehicle" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"campus_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"type" text NOT NULL,
	"seats" smallint NOT NULL,
	"plate" text NOT NULL,
	"color" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vehicle_type_valid" CHECK ("vehicle"."type" in ('car', 'bike')),
	CONSTRAINT "vehicle_seats_fit_type" CHECK (("vehicle"."type" = 'car' and "vehicle"."seats" between 1 and 6) or ("vehicle"."type" = 'bike' and "vehicle"."seats" = 1)),
	CONSTRAINT "vehicle_plate_clean" CHECK ("vehicle"."plate" = btrim("vehicle"."plate") and length("vehicle"."plate") between 1 and 20),
	CONSTRAINT "vehicle_color_clean" CHECK ("vehicle"."color" = btrim("vehicle"."color") and length("vehicle"."color") between 1 and 30)
);
--> statement-breakpoint
ALTER TABLE "vehicle" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "first_name" text;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "last_name" text;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "gender" text;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "department" text;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "phone_e164" text;--> statement-breakpoint
ALTER TABLE "preference" ADD CONSTRAINT "preference_campus_id_campus_id_fk" FOREIGN KEY ("campus_id") REFERENCES "public"."campus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference" ADD CONSTRAINT "preference_user_campus_fk" FOREIGN KEY ("user_id","campus_id") REFERENCES "public"."app_user"("id","campus_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference" ADD CONSTRAINT "preference_zone_campus_fk" FOREIGN KEY ("zone_id","campus_id") REFERENCES "public"."zone"("id","campus_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trusted_contact" ADD CONSTRAINT "trusted_contact_campus_id_campus_id_fk" FOREIGN KEY ("campus_id") REFERENCES "public"."campus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trusted_contact" ADD CONSTRAINT "trusted_contact_user_campus_fk" FOREIGN KEY ("user_id","campus_id") REFERENCES "public"."app_user"("id","campus_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_campus_id_campus_id_fk" FOREIGN KEY ("campus_id") REFERENCES "public"."campus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_owner_campus_fk" FOREIGN KEY ("owner_id","campus_id") REFERENCES "public"."app_user"("id","campus_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "preference_user_campus_idx" ON "preference" USING btree ("user_id","campus_id");--> statement-breakpoint
CREATE INDEX "preference_zone_campus_idx" ON "preference" USING btree ("zone_id","campus_id");--> statement-breakpoint
CREATE INDEX "trusted_contact_user_campus_idx" ON "trusted_contact" USING btree ("user_id","campus_id");--> statement-breakpoint
CREATE INDEX "vehicle_owner_campus_idx" ON "vehicle" USING btree ("owner_id","campus_id");--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_first_name_clean" CHECK ("app_user"."first_name" = btrim("app_user"."first_name") and length("app_user"."first_name") between 1 and 100);--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_last_name_clean" CHECK ("app_user"."last_name" = btrim("app_user"."last_name") and length("app_user"."last_name") between 1 and 100);--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_gender_valid" CHECK ("app_user"."gender" in ('female', 'male', 'unspecified'));--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_department_clean" CHECK ("app_user"."department" = btrim("app_user"."department") and length("app_user"."department") between 1 and 100);--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_phone_e164" CHECK ("app_user"."phone_e164" ~ '^[+][1-9][0-9]{7,14}$');--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_active_has_profile" CHECK ("app_user"."status" <> 'active' or ("app_user"."first_name" is not null and "app_user"."last_name" is not null and "app_user"."gender" is not null));--> statement-breakpoint
CREATE POLICY "preference_campus" ON "preference" AS PERMISSIVE FOR ALL TO "pulse_app" USING ("preference"."campus_id" = nullif(current_setting('app.campus_id', true), '')::uuid) WITH CHECK ("preference"."campus_id" = nullif(current_setting('app.campus_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "trusted_contact_campus" ON "trusted_contact" AS PERMISSIVE FOR ALL TO "pulse_app" USING ("trusted_contact"."campus_id" = nullif(current_setting('app.campus_id', true), '')::uuid) WITH CHECK ("trusted_contact"."campus_id" = nullif(current_setting('app.campus_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "vehicle_campus" ON "vehicle" AS PERMISSIVE FOR ALL TO "pulse_app" USING ("vehicle"."campus_id" = nullif(current_setting('app.campus_id', true), '')::uuid) WITH CHECK ("vehicle"."campus_id" = nullif(current_setting('app.campus_id', true), '')::uuid);