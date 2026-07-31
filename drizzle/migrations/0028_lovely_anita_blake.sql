CREATE TABLE "rfp_activity" (
	"id" serial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_email" text NOT NULL,
	"actor_admin" boolean DEFAULT false NOT NULL,
	"action" text NOT NULL,
	"subject_kind" text,
	"subject_id" text,
	"outcome" text DEFAULT 'ok' NOT NULL,
	"meta_json" text
);
--> statement-breakpoint
CREATE TABLE "rfp_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid,
	"owner_email" text NOT NULL,
	"title" text NOT NULL,
	"client_name" text,
	"source_kind" text NOT NULL,
	"source_name" text,
	"source_sha256" text,
	"source_bytes" integer,
	"raw_text" text NOT NULL,
	"injection_flagged" boolean DEFAULT false NOT NULL,
	"structure_json" text,
	"structure_confirmed_at" timestamp with time zone,
	"due_date" timestamp with time zone,
	"status" text DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rfp_knowledge_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid,
	"owner_email" text NOT NULL,
	"kind" text DEFAULT 'choice' NOT NULL,
	"fact_key" text,
	"category" text DEFAULT 'general' NOT NULL,
	"statement" text NOT NULL,
	"detail" text,
	"polarity" text DEFAULT 'affirmative' NOT NULL,
	"document_id" uuid,
	"status" text DEFAULT 'private' NOT NULL,
	"promoted_fact_id" text,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rfp_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"owner_user_id" uuid,
	"owner_email" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"rev" integer DEFAULT 0 NOT NULL,
	"drafted_against_kb_version" integer DEFAULT 0 NOT NULL,
	"sections_json" text DEFAULT '[]' NOT NULL,
	"gate_json" text,
	"gate_ran_at" timestamp with time zone,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"gen_started_at" timestamp with time zone,
	"gen_attempt_id" text,
	"gen_heartbeat_at" timestamp with time zone,
	"gen_progress" text,
	"gen_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rfp_requirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"structure_label" text NOT NULL,
	"text" text NOT NULL,
	"ordinal" integer NOT NULL,
	"kind" text DEFAULT 'question' NOT NULL,
	"mandatory" boolean DEFAULT true NOT NULL,
	"coverage_state" text DEFAULT 'uncovered' NOT NULL,
	"coverage_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rfp_documents" ADD CONSTRAINT "rfp_documents_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfp_knowledge_proposals" ADD CONSTRAINT "rfp_knowledge_proposals_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfp_knowledge_proposals" ADD CONSTRAINT "rfp_knowledge_proposals_document_id_rfp_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."rfp_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfp_proposals" ADD CONSTRAINT "rfp_proposals_document_id_rfp_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."rfp_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfp_proposals" ADD CONSTRAINT "rfp_proposals_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfp_requirements" ADD CONSTRAINT "rfp_requirements_document_id_rfp_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."rfp_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rfp_activity_at_idx" ON "rfp_activity" USING btree ("at");--> statement-breakpoint
CREATE INDEX "rfp_activity_actor_idx" ON "rfp_activity" USING btree ("actor_email","at");--> statement-breakpoint
CREATE INDEX "rfp_activity_subject_idx" ON "rfp_activity" USING btree ("subject_kind","subject_id","at");--> statement-breakpoint
CREATE INDEX "rfp_documents_owner_idx" ON "rfp_documents" USING btree ("owner_email","created_at");--> statement-breakpoint
CREATE INDEX "rfp_documents_status_idx" ON "rfp_documents" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "rfp_kprop_owner_idx" ON "rfp_knowledge_proposals" USING btree ("owner_email","status");--> statement-breakpoint
CREATE INDEX "rfp_kprop_status_idx" ON "rfp_knowledge_proposals" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "rfp_kprop_doc_idx" ON "rfp_knowledge_proposals" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "rfp_proposals_owner_idx" ON "rfp_proposals" USING btree ("owner_email","updated_at");--> statement-breakpoint
CREATE INDEX "rfp_proposals_doc_idx" ON "rfp_proposals" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "rfp_proposals_status_idx" ON "rfp_proposals" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "rfp_requirements_doc_idx" ON "rfp_requirements" USING btree ("document_id","ordinal");