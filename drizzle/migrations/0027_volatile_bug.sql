CREATE TABLE "rfp_facts" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"category" text NOT NULL,
	"statement" text NOT NULL,
	"polarity" text NOT NULL,
	"detail" text,
	"source_url" text,
	"verified_at" timestamp with time zone,
	"corrected_at" timestamp with time zone,
	"supersedes" text,
	"introduced_in_kb" integer NOT NULL,
	"retired_in_kb" integer,
	"confidence" text NOT NULL,
	CONSTRAINT "rfp_facts_key_kb_uq" UNIQUE("key","introduced_in_kb")
);
--> statement-breakpoint
CREATE TABLE "rfp_kb_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"note" text,
	CONSTRAINT "rfp_kb_versions_seq_uq" UNIQUE("seq")
);
--> statement-breakpoint
CREATE TABLE "rfp_questions" (
	"id" text PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"category" text NOT NULL,
	"answered_by_fact_key" text,
	"kind" text NOT NULL,
	"required" boolean NOT NULL,
	"ask_order" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rfp_rate_card_items" (
	"id" text PRIMARY KEY NOT NULL,
	"rate_card_id" text NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"unit_price_cents" bigint NOT NULL,
	"unit" text NOT NULL,
	"note" text,
	CONSTRAINT "rfp_rate_card_items_card_code_uq" UNIQUE("rate_card_id","code")
);
--> statement-breakpoint
CREATE TABLE "rfp_rate_cards" (
	"id" text PRIMARY KEY NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"minimum_fully_managed_users" integer NOT NULL,
	"minimum_monthly_fee_cents" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rfp_references" (
	"id" text PRIMARY KEY NOT NULL,
	"organization" text NOT NULL,
	"website" text,
	"segment" text NOT NULL,
	"contact_name" text,
	"contact_title" text,
	"contact_phone" text,
	"contact_email" text,
	"relationship_since" text,
	"usable_without_asking" boolean DEFAULT false NOT NULL,
	"notes" text,
	"retired_at" timestamp with time zone,
	"replaced_by" text
);
--> statement-breakpoint
ALTER TABLE "rfp_rate_card_items" ADD CONSTRAINT "rfp_rate_card_items_rate_card_id_rfp_rate_cards_id_fk" FOREIGN KEY ("rate_card_id") REFERENCES "public"."rfp_rate_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rfp_facts_corrected_at_idx" ON "rfp_facts" USING btree ("corrected_at");--> statement-breakpoint
CREATE INDEX "rfp_facts_key_idx" ON "rfp_facts" USING btree ("key");--> statement-breakpoint
CREATE INDEX "rfp_facts_polarity_idx" ON "rfp_facts" USING btree ("polarity");--> statement-breakpoint
CREATE INDEX "rfp_facts_supersedes_idx" ON "rfp_facts" USING btree ("supersedes");--> statement-breakpoint
CREATE INDEX "rfp_questions_ask_order_idx" ON "rfp_questions" USING btree ("ask_order");--> statement-breakpoint
CREATE INDEX "rfp_references_retired_at_idx" ON "rfp_references" USING btree ("retired_at");