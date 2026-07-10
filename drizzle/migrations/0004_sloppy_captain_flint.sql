CREATE TABLE "sms_prompt_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"event" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "sms_prompt_dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sms_prompt_events" ADD CONSTRAINT "sms_prompt_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;