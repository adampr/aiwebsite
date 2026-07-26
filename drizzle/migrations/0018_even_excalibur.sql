ALTER TABLE "blog_posts" ADD COLUMN "meta_rewritten_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "blog_posts" ADD COLUMN "meta_rewrite_note" text;