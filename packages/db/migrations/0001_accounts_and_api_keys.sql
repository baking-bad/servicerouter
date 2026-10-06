CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text,
	"email_confirmed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"kind" text NOT NULL,
	"key_hash" text NOT NULL,
	"label" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"revoked_at" timestamp (3) with time zone,
	CONSTRAINT "api_keys_kind_check" CHECK ("api_keys"."kind" in ('master', 'payment')),
	CONSTRAINT "api_keys_key_hash_check" CHECK ("api_keys"."key_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_key_hash_idx" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_account_idx" ON "api_keys" USING btree ("account_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_active_master_idx" ON "api_keys" USING btree ("account_id") WHERE kind = 'master' and revoked_at is null;