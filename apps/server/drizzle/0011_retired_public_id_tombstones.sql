ALTER TABLE "player_aliases" ADD COLUMN "source_public_player_id" text;--> statement-breakpoint
UPDATE "player_aliases" AS alias
SET "source_public_player_id" = receipt."conflicts" #>> '{source,publicPlayerId}'
FROM "identity_merge_receipts" AS receipt
WHERE receipt."source_player_id" = alias."source_player_id"
  AND alias."source_public_player_id" IS NULL;--> statement-breakpoint
ALTER TABLE "player_aliases" ALTER COLUMN "source_public_player_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "player_aliases" ADD CONSTRAINT "player_aliases_source_public_player_id_format"
  CHECK (source_public_player_id ~ '^[A-HJ-NP-Z2-9]{8}$');--> statement-breakpoint
CREATE UNIQUE INDEX "player_aliases_source_public_player_id_unique" ON "player_aliases" USING btree ("source_public_player_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION dotbot_allocate_public_player_id() RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
	candidate text;
	alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	random_bytes bytea;
	byte_index integer;
BEGIN
	LOOP
		random_bytes := decode(md5(gen_random_uuid()::text), 'hex');
		candidate := '';
		FOR byte_index IN 0..7 LOOP
			candidate := candidate || substr(alphabet, (get_byte(random_bytes, byte_index) % 32) + 1, 1);
		END LOOP;
		PERFORM pg_advisory_xact_lock(hashtextextended('dotbot-public-player-id:' || candidate, 0));
		IF NOT EXISTS (SELECT 1 FROM players WHERE public_player_id = candidate)
			AND NOT EXISTS (SELECT 1 FROM player_aliases WHERE source_public_player_id = candidate) THEN
			RETURN candidate;
		END IF;
	END LOOP;
END $$;
