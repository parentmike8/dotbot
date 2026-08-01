CREATE TABLE "player_aliases" (
	"source_player_id" uuid PRIMARY KEY NOT NULL,
	"target_player_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "player_aliases" ADD CONSTRAINT "player_aliases_target_player_id_players_id_fk" FOREIGN KEY ("target_player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;