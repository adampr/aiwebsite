CREATE TABLE "admin_emails" (
	"id" serial PRIMARY KEY NOT NULL,
	"to_email" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"session_id" text,
	"sent_by" text NOT NULL,
	"success" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "ip_orgs" (
	"id" serial PRIMARY KEY NOT NULL,
	"ip_address" "inet" NOT NULL,
	"asn" integer,
	"org_name" text,
	"is_isp" boolean DEFAULT false NOT NULL,
	"looked_up_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "ip_orgs_ip_address_unique" UNIQUE("ip_address")
);
--> statement-breakpoint
CREATE TABLE "page_visits" (
	"id" serial PRIMARY KEY NOT NULL,
	"path" text NOT NULL,
	"landing_url" text,
	"referrer" text,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"utm_term" text,
	"utm_content" text,
	"ip_address" "inet",
	"user_agent" text,
	"session_hash" text,
	"status_code" integer DEFAULT 200,
	"created_at" timestamp with time zone DEFAULT now()
);
