CREATE TABLE "payout_items" (
	"payout_id" text NOT NULL,
	"service_id" text NOT NULL,
	"amount" bigint NOT NULL,
	CONSTRAINT "payout_items_pkey" PRIMARY KEY("payout_id","service_id"),
	CONSTRAINT "payout_items_amount_check" CHECK ("payout_items"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "payout_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"cutoff" timestamp (3) with time zone NOT NULL,
	"status" text NOT NULL,
	"asset" text NOT NULL,
	"total" bigint NOT NULL,
	"problem" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	"approved_at" timestamp (3) with time zone,
	"approved_by" text,
	CONSTRAINT "payout_runs_status_check" CHECK ("payout_runs"."status" in ('awaiting_approval', 'approved', 'submitted', 'confirmed', 'failed', 'stopped', 'empty'))
);
--> statement-breakpoint
CREATE TABLE "payout_transactions" (
	"run_id" text NOT NULL,
	"index" integer NOT NULL,
	"tx_hash" text NOT NULL,
	"cbor" text NOT NULL,
	"valid_until" timestamp (3) with time zone NOT NULL,
	"status" text NOT NULL,
	"submitted_at" timestamp (3) with time zone,
	"finished_at" timestamp (3) with time zone,
	CONSTRAINT "payout_transactions_pkey" PRIMARY KEY("run_id","index"),
	CONSTRAINT "payout_transactions_status_check" CHECK ("payout_transactions"."status" in ('built', 'submitted', 'confirmed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"seller_account_id" text NOT NULL,
	"address" text NOT NULL,
	"amount" bigint NOT NULL,
	"quantity" bigint NOT NULL,
	"transaction_index" integer NOT NULL,
	"status" text NOT NULL,
	"ledger_transaction_id" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"confirmed_at" timestamp (3) with time zone,
	CONSTRAINT "payouts_amount_check" CHECK ("payouts"."amount" > 0 and "payouts"."quantity" > 0),
	CONSTRAINT "payouts_status_check" CHECK ("payouts"."status" in ('pending', 'confirmed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "reconciliation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"ran_at" timestamp (3) with time zone NOT NULL,
	"results" json NOT NULL,
	"alerts" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "treasury_transfers" (
	"reference" text PRIMARY KEY NOT NULL,
	"from_asset" text NOT NULL,
	"from_amount" bigint NOT NULL,
	"to_asset" text NOT NULL,
	"to_amount" bigint NOT NULL,
	"transactions" json NOT NULL,
	"recorded_by" text NOT NULL,
	"ledger_transaction_id" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "treasury_transfers_amounts_check" CHECK ("treasury_transfers"."from_amount" > 0 and "treasury_transfers"."to_amount" > 0 and "treasury_transfers"."to_amount" <= "treasury_transfers"."from_amount")
);
--> statement-breakpoint
ALTER TABLE "payout_items" ADD CONSTRAINT "payout_items_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_items" ADD CONSTRAINT "payout_items_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_transactions" ADD CONSTRAINT "payout_transactions_run_id_payout_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payout_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_run_id_payout_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payout_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_seller_account_id_accounts_id_fk" FOREIGN KEY ("seller_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_transaction_fk" FOREIGN KEY ("run_id","transaction_index") REFERENCES "public"."payout_transactions"("run_id","index") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payout_items_service_idx" ON "payout_items" USING btree ("service_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payout_runs_cutoff_idx" ON "payout_runs" USING btree ("cutoff");--> statement-breakpoint
CREATE INDEX "payout_runs_status_idx" ON "payout_runs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "payout_transactions_tx_hash_idx" ON "payout_transactions" USING btree ("tx_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_run_seller_address_idx" ON "payouts" USING btree ("run_id","seller_account_id","address");--> statement-breakpoint
CREATE INDEX "payouts_seller_idx" ON "payouts" USING btree ("seller_account_id");--> statement-breakpoint
CREATE INDEX "reconciliation_runs_ran_at_idx" ON "reconciliation_runs" USING btree ("ran_at");