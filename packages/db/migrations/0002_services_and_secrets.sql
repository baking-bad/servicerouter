CREATE TABLE "service_revisions" (
	"service_id" text NOT NULL,
	"number" integer NOT NULL,
	"config_text" text NOT NULL,
	"config_media_type" text NOT NULL,
	"config" json NOT NULL,
	"openapi_documents" json NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "service_revisions_pkey" PRIMARY KEY("service_id","number"),
	CONSTRAINT "service_revisions_number_check" CHECK ("service_revisions"."number" >= 1)
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_account_id" text NOT NULL,
	"state" text NOT NULL,
	"active_revision" integer,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "services_state_check" CHECK ("services"."state" in ('pending', 'live', 'suspended'))
);
--> statement-breakpoint
CREATE TABLE "service_secrets" (
	"service_id" text NOT NULL,
	"name" text NOT NULL,
	"version" smallint NOT NULL,
	"key_id" text NOT NULL,
	"wrapped_key" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"tag" "bytea" NOT NULL,
	"origin" text NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "service_secrets_pkey" PRIMARY KEY("service_id","name"),
	CONSTRAINT "service_secrets_origin_check" CHECK ("service_secrets"."origin" like 'https://%')
);
--> statement-breakpoint
ALTER TABLE "service_revisions" ADD CONSTRAINT "service_revisions_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_revisions" ADD CONSTRAINT "service_revisions_created_by_accounts_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_active_revision_fk" FOREIGN KEY ("id","active_revision") REFERENCES "public"."service_revisions"("service_id","number") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_secrets" ADD CONSTRAINT "service_secrets_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "services_owner_idx" ON "services" USING btree ("owner_account_id");