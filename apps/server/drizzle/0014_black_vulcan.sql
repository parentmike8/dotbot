ALTER TABLE "party_queue_claims" ADD COLUMN "loadout_snapshots" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "party_queue_claims" ADD COLUMN "started_match_id" uuid;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "loadout_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE FUNCTION "dotbot_enforce_loadout_revision"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."loadout_revision" < OLD."loadout_revision" THEN
    RAISE EXCEPTION 'loadout revision cannot move backward' USING ERRCODE = '23514';
  END IF;
  IF NEW."loadout" IS DISTINCT FROM OLD."loadout"
    AND NEW."loadout_revision" <= OLD."loadout_revision" THEN
    NEW."loadout_revision" := OLD."loadout_revision" + 1;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "players_loadout_revision_trigger" BEFORE UPDATE OF "loadout", "loadout_revision" ON "players" FOR EACH ROW EXECUTE FUNCTION "dotbot_enforce_loadout_revision"();--> statement-breakpoint
UPDATE "party_queue_claims" SET "status" = 'cancelled', "updated_at" = now() WHERE "status" = 'active';--> statement-breakpoint
ALTER TABLE "party_queue_claims" DROP CONSTRAINT "party_queue_claims_status_check";--> statement-breakpoint
ALTER TABLE "party_queue_claims" ADD CONSTRAINT "party_queue_claims_status_check" CHECK ("status" IN ('active', 'cancelling', 'cancelled', 'completed'));--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_loadout_revision_check" CHECK ("loadout_revision" >= 1);--> statement-breakpoint
ALTER TABLE "party_queue_claims" ADD CONSTRAINT "party_queue_claims_loadout_snapshots_check" CHECK (jsonb_typeof("loadout_snapshots") = 'array' AND (jsonb_array_length("loadout_snapshots") BETWEEN 1 AND 3 OR ("status" = 'cancelled' AND jsonb_array_length("loadout_snapshots") = 0)));
