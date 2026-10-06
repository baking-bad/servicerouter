CREATE TABLE "balances" (
	"ledger_account_id" text PRIMARY KEY NOT NULL,
	"balance" bigint NOT NULL,
	"may_go_negative" boolean NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "balances_not_negative_check" CHECK ("balances"."may_go_negative" or "balances"."balance" >= 0)
);
--> statement-breakpoint
CREATE TABLE "key_daily_spend" (
	"key_id" text NOT NULL,
	"day" date NOT NULL,
	"spent" bigint NOT NULL,
	CONSTRAINT "key_daily_spend_pkey" PRIMARY KEY("key_id","day"),
	CONSTRAINT "key_daily_spend_spent_check" CHECK ("key_daily_spend"."spent" >= 0)
);
--> statement-breakpoint
CREATE TABLE "key_total_spend" (
	"key_id" text PRIMARY KEY NOT NULL,
	"spent" bigint NOT NULL,
	CONSTRAINT "key_total_spend_spent_check" CHECK ("key_total_spend"."spent" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text,
	"type" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"transaction_id" text NOT NULL,
	"ledger_account_id" text NOT NULL,
	"amount" bigint NOT NULL,
	CONSTRAINT "ledger_entries_amount_check" CHECK ("ledger_entries"."amount" <> 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"operation" text NOT NULL,
	"reference" text NOT NULL,
	"request_id" text,
	"created_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text,
	"kind" text NOT NULL,
	"rail" text NOT NULL,
	"buyer_account_id" text,
	"key_id" text,
	"seller_account_id" text,
	"service_id" text,
	"route_key" text,
	"target_host" text,
	"target_path" text,
	"network" text,
	"asset" text,
	"atomic_amount" numeric(78, 0),
	"amount" bigint NOT NULL,
	"fee" bigint,
	"decision" text,
	"upstream_status" integer,
	"upstream_latency_ms" integer,
	"status" text NOT NULL,
	"transaction_hash" text,
	"receipt" text,
	"needs_review" boolean NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "payments_kind_check" CHECK ("payments"."kind" in ('service', 'routed')),
	CONSTRAINT "payments_rail_check" CHECK ("payments"."rail" in ('credits', 'x402', 'mpp')),
	CONSTRAINT "payments_status_check" CHECK ("payments"."status" in ('held', 'verified', 'captured', 'settling', 'settled', 'released', 'cancelled', 'failed')),
	CONSTRAINT "payments_decision_check" CHECK ("payments"."decision" in ('billable', 'not_billable')),
	CONSTRAINT "payments_amounts_check" CHECK ("payments"."amount" >= 0 and "payments"."fee" >= 0 and "payments"."fee" <= "payments"."amount")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "allowance" bigint;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "daily_budget" bigint;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "max_price" bigint;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "expires_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "balances" ADD CONSTRAINT "balances_ledger_account_id_ledger_accounts_id_fk" FOREIGN KEY ("ledger_account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "key_daily_spend" ADD CONSTRAINT "key_daily_spend_key_id_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "key_total_spend" ADD CONSTRAINT "key_total_spend_key_id_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_ledger_account_id_ledger_accounts_id_fk" FOREIGN KEY ("ledger_account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_buyer_account_id_accounts_id_fk" FOREIGN KEY ("buyer_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_key_id_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_seller_account_id_accounts_id_fk" FOREIGN KEY ("seller_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_accounts_account_idx" ON "ledger_accounts" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_transaction_idx" ON "ledger_entries" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_account_idx" ON "ledger_entries" USING btree ("ledger_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_transactions_operation_reference_idx" ON "ledger_transactions" USING btree ("operation","reference");--> statement-breakpoint
CREATE INDEX "payments_buyer_idx" ON "payments" USING btree ("buyer_account_id","created_at","id");--> statement-breakpoint
CREATE INDEX "payments_service_idx" ON "payments" USING btree ("service_id","status");--> statement-breakpoint
CREATE INDEX "payments_status_idx" ON "payments" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_limits_check" CHECK ("api_keys"."allowance" >= 0 and "api_keys"."daily_budget" >= 0 and "api_keys"."max_price" >= 0);--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_payment_limits_check" CHECK (case when "api_keys"."kind" = 'payment' then "api_keys"."daily_budget" is not null
    else "api_keys"."allowance" is null and "api_keys"."daily_budget" is null and "api_keys"."max_price" is null and "api_keys"."expires_at" is null end);