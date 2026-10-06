CREATE TABLE "payout_confirmations" (
	"service_id" text PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"token" text NOT NULL,
	"payouts" json NOT NULL,
	"hosts" text[] NOT NULL,
	"confirmed_hosts" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"next_check_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "payout_confirmations_token_check" CHECK ("payout_confirmations"."token" ~ '^sr-confirm=[0-9a-f]{32}$')
);
--> statement-breakpoint
CREATE TABLE "upstream_hosts" (
	"account_id" text NOT NULL,
	"host" text NOT NULL,
	"state" text NOT NULL,
	"missing_since" timestamp (3) with time zone,
	"checked_at" timestamp (3) with time zone,
	"problem" text,
	"next_check_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "upstream_hosts_pkey" PRIMARY KEY("account_id","host"),
	CONSTRAINT "upstream_hosts_state_check" CHECK ("upstream_hosts"."state" in ('unverified', 'verified', 'missing', 'suspended')),
	CONSTRAINT "upstream_hosts_problem_check" CHECK ("upstream_hosts"."problem" in ('file_not_found', 'fetch_failed', 'invalid_file', 'token_missing')),
	CONSTRAINT "upstream_hosts_missing_check" CHECK ("upstream_hosts"."state" not in ('missing', 'suspended') or "upstream_hosts"."missing_since" is not null)
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
	"account_id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "verification_tokens_token_check" CHECK ("verification_tokens"."token" ~ '^sr-verify=[0-9a-f]{32}$')
);
--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "hosts" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "payout_confirmations" ADD CONSTRAINT "payout_confirmations_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_confirmations" ADD CONSTRAINT "payout_confirmations_revision_fk" FOREIGN KEY ("service_id","revision") REFERENCES "public"."service_revisions"("service_id","number") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upstream_hosts" ADD CONSTRAINT "upstream_hosts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_tokens" ADD CONSTRAINT "verification_tokens_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payout_confirmations_token_idx" ON "payout_confirmations" USING btree ("token");--> statement-breakpoint
CREATE INDEX "payout_confirmations_next_check_idx" ON "payout_confirmations" USING btree ("next_check_at");--> statement-breakpoint
CREATE INDEX "upstream_hosts_next_check_idx" ON "upstream_hosts" USING btree ("next_check_at");--> statement-breakpoint
CREATE UNIQUE INDEX "verification_tokens_token_idx" ON "verification_tokens" USING btree ("token");--> statement-breakpoint
-- The active revision's hosts of every existing service (OV-5)
UPDATE "services" SET "hosts" = coalesce((
	SELECT array_agg(DISTINCT lower(substring(upstream->>'baseUrl' from '^https://([^:/?#]+)')))
	FROM "service_revisions" AS revision, json_array_elements(revision."config"->'upstreams') AS upstream
	WHERE revision."service_id" = "services"."id" AND revision."number" = "services"."active_revision"
), '{}');--> statement-breakpoint
-- Services already live keep serving: their hosts count as verified and are checked at once, so a host
-- without the token gets its notice and grace period like any other (OV-4)
INSERT INTO "upstream_hosts" ("account_id", "host", "state", "next_check_at", "updated_at")
SELECT DISTINCT "owner_account_id", unnest("hosts"), 'verified', now(), now() FROM "services" WHERE "state" = 'live'
ON CONFLICT DO NOTHING;
