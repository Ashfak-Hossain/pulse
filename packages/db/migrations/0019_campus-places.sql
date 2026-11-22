-- drizzle-kit 0.31 drops the SRID from geometry columns; 4326 added by hand (test: places.int)
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"campus_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_hash" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_action_shape" CHECK ("audit_log"."action" ~ '^[a-z_]+[.][a-z_]+$'),
	CONSTRAINT "audit_log_action_short" CHECK (length("audit_log"."action") <= 64),
	CONSTRAINT "audit_log_entity_clean" CHECK ("audit_log"."entity" = btrim("audit_log"."entity") and length("audit_log"."entity") between 1 and 64),
	CONSTRAINT "audit_log_metadata_object" CHECK (jsonb_typeof("audit_log"."metadata") = 'object'),
	CONSTRAINT "audit_log_ip_hash_hex" CHECK ("audit_log"."ip_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "campus_gate" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"campus_id" uuid NOT NULL,
	"name" text NOT NULL,
	"location" geometry(point, 4326) NOT NULL,
	"cell" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campus_gate_id_campus_unique" UNIQUE("id","campus_id"),
	CONSTRAINT "campus_gate_campus_name_unique" UNIQUE("campus_id","name"),
	CONSTRAINT "campus_gate_name_clean" CHECK ("campus_gate"."name" = btrim("campus_gate"."name") and length("campus_gate"."name") between 1 and 100),
	CONSTRAINT "campus_gate_cell_h3" CHECK ("campus_gate"."cell" ~ '^[0-9a-f]{15}$')
);
--> statement-breakpoint
ALTER TABLE "campus_gate" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "meeting_point" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"campus_id" uuid NOT NULL,
	"zone_id" uuid,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"location" geometry(point, 4326) NOT NULL,
	"cell" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_point_id_campus_unique" UNIQUE("id","campus_id"),
	CONSTRAINT "meeting_point_name_clean" CHECK ("meeting_point"."name" = btrim("meeting_point"."name") and length("meeting_point"."name") between 1 and 100),
	CONSTRAINT "meeting_point_kind_valid" CHECK ("meeting_point"."kind" in ('gate', 'landmark', 'bus_stop', 'junction')),
	CONSTRAINT "meeting_point_cell_h3" CHECK ("meeting_point"."cell" ~ '^[0-9a-f]{15}$')
);
--> statement-breakpoint
ALTER TABLE "meeting_point" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "zone" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"campus_id" uuid NOT NULL,
	"name" text NOT NULL,
	"area" geometry(MultiPolygon,4326) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "zone_id_campus_unique" UNIQUE("id","campus_id"),
	CONSTRAINT "zone_campus_name_unique" UNIQUE("campus_id","name"),
	CONSTRAINT "zone_name_clean" CHECK ("zone"."name" = btrim("zone"."name") and length("zone"."name") between 1 and 100),
	CONSTRAINT "zone_area_valid" CHECK (ST_IsValid("zone"."area"))
);
--> statement-breakpoint
ALTER TABLE "zone" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_campus_id_campus_id_fk" FOREIGN KEY ("campus_id") REFERENCES "public"."campus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_campus_fk" FOREIGN KEY ("actor_id","campus_id") REFERENCES "public"."app_user"("id","campus_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus_gate" ADD CONSTRAINT "campus_gate_campus_id_campus_id_fk" FOREIGN KEY ("campus_id") REFERENCES "public"."campus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_point" ADD CONSTRAINT "meeting_point_campus_id_campus_id_fk" FOREIGN KEY ("campus_id") REFERENCES "public"."campus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_point" ADD CONSTRAINT "meeting_point_zone_campus_fk" FOREIGN KEY ("zone_id","campus_id") REFERENCES "public"."zone"("id","campus_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zone" ADD CONSTRAINT "zone_campus_id_campus_id_fk" FOREIGN KEY ("campus_id") REFERENCES "public"."campus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_campus_at_idx" ON "audit_log" USING btree ("campus_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_actor_campus_idx" ON "audit_log" USING btree ("actor_id","campus_id");--> statement-breakpoint
CREATE UNIQUE INDEX "campus_gate_one_primary_per_campus" ON "campus_gate" USING btree ("campus_id") WHERE "campus_gate"."is_primary";--> statement-breakpoint
CREATE INDEX "meeting_point_campus_idx" ON "meeting_point" USING btree ("campus_id");--> statement-breakpoint
CREATE INDEX "meeting_point_zone_campus_idx" ON "meeting_point" USING btree ("zone_id","campus_id");--> statement-breakpoint
CREATE INDEX "meeting_point_location_gist_idx" ON "meeting_point" USING gist ("location");--> statement-breakpoint
CREATE INDEX "zone_area_gist_idx" ON "zone" USING gist ("area");--> statement-breakpoint
CREATE POLICY "audit_log_read" ON "audit_log" AS PERMISSIVE FOR SELECT TO "pulse_app" USING ("audit_log"."campus_id" = nullif(current_setting('app.campus_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "audit_log_insert" ON "audit_log" AS PERMISSIVE FOR INSERT TO "pulse_app" WITH CHECK ("audit_log"."campus_id" = nullif(current_setting('app.campus_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "campus_gate_campus" ON "campus_gate" AS PERMISSIVE FOR ALL TO "pulse_app" USING ("campus_gate"."campus_id" = nullif(current_setting('app.campus_id', true), '')::uuid) WITH CHECK ("campus_gate"."campus_id" = nullif(current_setting('app.campus_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "meeting_point_campus" ON "meeting_point" AS PERMISSIVE FOR ALL TO "pulse_app" USING ("meeting_point"."campus_id" = nullif(current_setting('app.campus_id', true), '')::uuid) WITH CHECK ("meeting_point"."campus_id" = nullif(current_setting('app.campus_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "zone_campus" ON "zone" AS PERMISSIVE FOR ALL TO "pulse_app" USING ("zone"."campus_id" = nullif(current_setting('app.campus_id', true), '')::uuid) WITH CHECK ("zone"."campus_id" = nullif(current_setting('app.campus_id', true), '')::uuid);