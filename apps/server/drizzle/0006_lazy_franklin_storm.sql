CREATE TABLE "base_upgrades" (
	"player_id" uuid NOT NULL,
	"upgrade_id" text NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "base_upgrades_player_id_upgrade_id_pk" PRIMARY KEY("player_id","upgrade_id")
);
--> statement-breakpoint
ALTER TABLE "base_upgrades" ADD CONSTRAINT "base_upgrades_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;