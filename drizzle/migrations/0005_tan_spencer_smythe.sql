CREATE TABLE "memory_deletion_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"requester_ids" text NOT NULL,
	"deleted_counts" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "sms_memory_notices" (
	"id" serial PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "sms_memory_notices_phone_unique" UNIQUE("phone")
);
