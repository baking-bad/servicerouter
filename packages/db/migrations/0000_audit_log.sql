CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"occurred_at" timestamp (3) with time zone NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"request_id" text,
	"details" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "audit_log_subject_idx" ON "audit_log" USING btree ("subject_kind","subject_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_kind","actor_id","occurred_at");