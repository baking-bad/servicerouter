CREATE TABLE "catalog_entries" (
	"service_id" text PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"description" text NOT NULL,
	"category" text NOT NULL,
	"tags" text[] NOT NULL,
	"links" json NOT NULL,
	"contact" json NOT NULL,
	"price_from" bigint NOT NULL,
	"methods" text[] NOT NULL,
	"routes" json NOT NULL,
	"search" "tsvector" NOT NULL,
	"listed_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_stats" (
	"service_id" text NOT NULL,
	"route_key" text NOT NULL,
	"calls_30d" integer NOT NULL,
	"success_rate" double precision NOT NULL,
	"p50_ms" integer NOT NULL,
	"p95_ms" integer NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "service_stats_pkey" PRIMARY KEY("service_id","route_key")
);
--> statement-breakpoint
ALTER TABLE "routed_endpoints" ADD COLUMN "last_price" bigint;--> statement-breakpoint
ALTER TABLE "catalog_entries" ADD CONSTRAINT "catalog_entries_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_stats" ADD CONSTRAINT "service_stats_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "catalog_entries_category_idx" ON "catalog_entries" USING btree ("category");--> statement-breakpoint
CREATE INDEX "catalog_entries_search_idx" ON "catalog_entries" USING gin ("search");