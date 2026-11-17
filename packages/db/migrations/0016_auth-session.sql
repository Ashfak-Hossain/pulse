CREATE TABLE "auth_session" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"campus_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"rotated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	"user_agent" text,
	"ip_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_session_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "auth_session_token_hash_hex" CHECK ("auth_session"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "auth_session_ip_hash_hex" CHECK ("auth_session"."ip_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "auth_session_expires_window" CHECK ("auth_session"."expires_at" > "auth_session"."created_at" and "auth_session"."expires_at" <= "auth_session"."created_at" + interval '30 days'),
	CONSTRAINT "auth_session_user_agent_length" CHECK (char_length("auth_session"."user_agent") <= 200),
	CONSTRAINT "auth_session_revoke_reason_valid" CHECK ("auth_session"."revoke_reason" in ('sign_out', 'sign_out_all', 'reuse_detected', 'suspended', 'deleted')),
	CONSTRAINT "auth_session_revoked_with_reason" CHECK (("auth_session"."revoked_at" is null) = ("auth_session"."revoke_reason" is null))
);
--> statement-breakpoint
ALTER TABLE "auth_session" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_campus_id_campus_id_fk" FOREIGN KEY ("campus_id") REFERENCES "public"."campus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_campus_fk" FOREIGN KEY ("user_id","campus_id") REFERENCES "public"."app_user"("id","campus_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_session_campus_user_idx" ON "auth_session" USING btree ("campus_id","user_id");--> statement-breakpoint
CREATE INDEX "auth_session_family_idx" ON "auth_session" USING btree ("family_id");--> statement-breakpoint
CREATE POLICY "auth_session_campus" ON "auth_session" AS PERMISSIVE FOR ALL TO "pulse_app" USING ("auth_session"."campus_id" = nullif(current_setting('app.campus_id', true), '')::uuid) WITH CHECK ("auth_session"."campus_id" = nullif(current_setting('app.campus_id', true), '')::uuid);
