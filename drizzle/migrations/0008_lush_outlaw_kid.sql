CREATE TABLE "blog_hero_images" (
	"slug" text PRIMARY KEY NOT NULL,
	"data" "bytea" NOT NULL,
	"mime" text DEFAULT 'image/webp' NOT NULL,
	"content_hash" text,
	"updated_at" timestamp with time zone DEFAULT now()
);
