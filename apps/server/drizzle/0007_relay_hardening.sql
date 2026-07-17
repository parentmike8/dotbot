CREATE TABLE "relay_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "match_participants" ADD COLUMN "starting_loadout" jsonb DEFAULT '[]'::jsonb NOT NULL;