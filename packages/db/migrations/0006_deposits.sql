CREATE SEQUENCE "public"."deposit_address_index" INCREMENT BY 1 MINVALUE 0 MAXVALUE 9223372036854775807 START WITH 0 CACHE 1;--> statement-breakpoint
CREATE TABLE "deposit_addresses" (
	"account_id" text PRIMARY KEY NOT NULL,
	"derivation_index" integer NOT NULL,
	"address" text NOT NULL,
	"network" text NOT NULL,
	"topup_token" text NOT NULL,
	"scanned_height" integer DEFAULT 0 NOT NULL,
	"tip_height" integer,
	"next_check_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "deposit_addresses_index_check" CHECK ("deposit_addresses"."derivation_index" >= 0)
);
--> statement-breakpoint
CREATE TABLE "deposits" (
	"tx_hash" text NOT NULL,
	"output_index" integer NOT NULL,
	"account_id" text NOT NULL,
	"address" text NOT NULL,
	"quantity" bigint NOT NULL,
	"usd_amount" bigint,
	"amounts" json NOT NULL,
	"block_height" integer NOT NULL,
	"block_time" timestamp (3) with time zone NOT NULL,
	"status" text NOT NULL,
	"ledger_transaction_id" text,
	"seen_at" timestamp (3) with time zone NOT NULL,
	"credited_at" timestamp (3) with time zone,
	CONSTRAINT "deposits_pkey" PRIMARY KEY("tx_hash","output_index"),
	CONSTRAINT "deposits_status_check" CHECK ("deposits"."status" in ('pending', 'credited', 'not_credited', 'dropped')),
	CONSTRAINT "deposits_credit_check" CHECK ("deposits"."status" <> 'credited' or ("deposits"."usd_amount" > 0 and "deposits"."ledger_transaction_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "deposit_addresses" ADD CONSTRAINT "deposit_addresses_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deposit_addresses_index_idx" ON "deposit_addresses" USING btree ("derivation_index");--> statement-breakpoint
CREATE UNIQUE INDEX "deposit_addresses_address_idx" ON "deposit_addresses" USING btree ("address");--> statement-breakpoint
CREATE UNIQUE INDEX "deposit_addresses_topup_token_idx" ON "deposit_addresses" USING btree ("topup_token");--> statement-breakpoint
CREATE INDEX "deposit_addresses_next_check_idx" ON "deposit_addresses" USING btree ("next_check_at");--> statement-breakpoint
CREATE INDEX "deposits_account_idx" ON "deposits" USING btree ("account_id","seen_at");--> statement-breakpoint
CREATE INDEX "deposits_address_status_idx" ON "deposits" USING btree ("address","status");