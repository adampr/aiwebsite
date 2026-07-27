CREATE TABLE "blog_audio" (
	"slug" text PRIMARY KEY NOT NULL,
	"data" "bytea",
	"url" text NOT NULL,
	"mime" text DEFAULT 'audio/mpeg' NOT NULL,
	"content_hash" text,
	"render_hash" text,
	"duration_sec" integer,
	"byte_length" integer,
	"voice" text,
	"model_id" text,
	"chapters" text,
	"guid" text,
	"stale" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
-- Hand-added (module MIGRATIONS v1.38.0): drizzle will not emit a storage
-- clause. MP3 is incompressible, so postgres would decline pglz anyway — this
-- makes uncompressed-external a CONTRACT, which is what lets the audio route's
-- substring() byte-range read be a genuine slice instead of a full detoast of
-- a multi-megabyte value on every iOS seek.
ALTER TABLE "blog_audio" ALTER COLUMN "data" SET STORAGE EXTERNAL;
