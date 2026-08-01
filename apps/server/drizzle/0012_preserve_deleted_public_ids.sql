ALTER TABLE "player_aliases" DROP CONSTRAINT "player_aliases_target_player_id_players_id_fk";
--> statement-breakpoint
ALTER TABLE "player_aliases" ALTER COLUMN "target_player_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "player_aliases" ADD CONSTRAINT "player_aliases_target_player_id_players_id_fk" FOREIGN KEY ("target_player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE OR REPLACE FUNCTION dotbot_tombstone_deleted_public_player_id() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	-- Serialize with both the identity-aware allocator and the DEFAULT used by
	-- an older service revision. This closes the delete/insert reuse window.
	PERFORM pg_advisory_xact_lock(hashtextextended('dotbot-public-player-id:' || OLD.public_player_id, 0));
	INSERT INTO player_aliases (source_player_id, source_public_player_id, target_player_id)
	VALUES (OLD.id, OLD.public_player_id, NULL)
	ON CONFLICT (source_player_id) DO UPDATE
		SET source_public_player_id = EXCLUDED.source_public_player_id;
	-- A merge inserts a live redirect before deleting its source. The conflict
	-- update deliberately preserves that existing non-null target.
	RETURN OLD;
END $$;--> statement-breakpoint
CREATE TRIGGER dotbot_tombstone_player_before_delete
BEFORE DELETE ON players
FOR EACH ROW EXECUTE FUNCTION dotbot_tombstone_deleted_public_player_id();
