CREATE TABLE "auth_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"email" text NOT NULL,
	"auth_provider" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"success" boolean NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"auth_provider" text NOT NULL,
	"email_domain" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"last_login_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "auth_logs" ADD CONSTRAINT "auth_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;