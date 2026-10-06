CREATE TABLE "service_documents" (
	"service_id" text NOT NULL,
	"revision" integer NOT NULL,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"etag" text NOT NULL,
	"inputs_hash" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "service_documents_pkey" PRIMARY KEY("service_id","revision","kind"),
	CONSTRAINT "service_documents_kind_check" CHECK ("service_documents"."kind" in ('openapi.json', 'llms.txt', 'skill.md', 'bazaar.json'))
);
--> statement-breakpoint
ALTER TABLE "service_documents" ADD CONSTRAINT "service_documents_revision_fk" FOREIGN KEY ("service_id","revision") REFERENCES "public"."service_revisions"("service_id","number") ON DELETE no action ON UPDATE no action;