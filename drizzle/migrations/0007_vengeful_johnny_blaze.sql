CREATE TABLE "sms_notices" (
	"id" serial PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"kind" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "blog_posts" ADD COLUMN "prune_step" text;--> statement-breakpoint
ALTER TABLE "blog_posts" ADD COLUMN "prune_step_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "blog_posts" ADD COLUMN "prune_redirect_to" text;--> statement-breakpoint
CREATE UNIQUE INDEX "sms_notices_phone_kind_idx" ON "sms_notices" USING btree ("phone","kind");