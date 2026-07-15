CREATE TABLE "base_layouts" (
	"player_id" uuid NOT NULL,
	"slot_id" text NOT NULL,
	"object_kind" text NOT NULL,
	CONSTRAINT "base_layouts_player_id_slot_id_pk" PRIMARY KEY("player_id","slot_id")
);
--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "loadout" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "base_layouts" ADD CONSTRAINT "base_layouts_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;