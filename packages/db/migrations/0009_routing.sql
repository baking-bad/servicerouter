CREATE TABLE "host_blocklist" (
	"host" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routed_endpoints" (
	"host" text NOT NULL,
	"path" text NOT NULL,
	"fee_bps" integer,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "routed_endpoints_pkey" PRIMARY KEY("host","path"),
	CONSTRAINT "routed_endpoints_fee_check" CHECK ("routed_endpoints"."fee_bps" is null or ("routed_endpoints"."fee_bps" >= 0 and "routed_endpoints"."fee_bps" <= 10000))
);
--> statement-breakpoint
CREATE TABLE "signatures" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text,
	"quote_id" text NOT NULL,
	"protocol" text NOT NULL,
	"network" text NOT NULL,
	"asset" text NOT NULL,
	"atomic_amount" bigint NOT NULL,
	"amount" bigint NOT NULL,
	"pay_to" text NOT NULL,
	"resource" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "target_payments" (
	"payment_id" text PRIMARY KEY NOT NULL,
	"protocol" text NOT NULL,
	"network" text NOT NULL,
	"asset" text NOT NULL,
	"amount" bigint NOT NULL,
	"atomic_amount" bigint NOT NULL,
	"pay_to" text NOT NULL,
	"signature_id" text NOT NULL,
	"status" text NOT NULL,
	"receipt" text,
	"transaction_hash" text,
	"loss_booked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "target_payments_amount_check" CHECK ("target_payments"."amount" > 0 and "target_payments"."atomic_amount" > 0),
	CONSTRAINT "target_payments_status_check" CHECK ("target_payments"."status" in ('signed', 'settled', 'failed', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "target_payments" ADD CONSTRAINT "target_payments_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "signatures_network_created_idx" ON "signatures" USING btree ("network","created_at");--> statement-breakpoint
CREATE INDEX "target_payments_status_idx" ON "target_payments" USING btree ("status","created_at");