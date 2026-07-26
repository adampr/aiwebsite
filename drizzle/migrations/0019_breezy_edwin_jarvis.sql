CREATE TABLE "blog_metrics" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"day" date NOT NULL,
	"source" text NOT NULL,
	"impressions" integer,
	"clicks" integer,
	"avg_position" real,
	"visits" integer,
	"unique_visitors" integer,
	"top_queries" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "blog_metrics_slug_day_source_idx" ON "blog_metrics" USING btree ("slug","day","source");--> statement-breakpoint
CREATE INDEX "blog_metrics_slug_day_idx" ON "blog_metrics" USING btree ("slug","day" DESC NULLS LAST);