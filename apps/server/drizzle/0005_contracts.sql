CREATE TABLE "contracts" (
	"id" text PRIMARY KEY NOT NULL,
	"player_id" uuid NOT NULL,
	"contract" jsonb NOT NULL,
	"status" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "contract_reroll" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;