CREATE TABLE "contact_submissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"company" text,
	"phone" text,
	"message" text NOT NULL,
	"ip_address" "inet",
	"created_at" timestamp with time zone DEFAULT now()
);
