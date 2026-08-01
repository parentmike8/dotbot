ALTER TABLE "party_queue_claims" ADD COLUMN "loadout_snapshots" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "party_queue_claims" ADD COLUMN "started_match_id" uuid;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "loadout_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
UPDATE "party_queue_claims" SET "status" = 'cancelled', "updated_at" = now() WHERE "status" = 'active';--> statement-breakpoint
ALTER TABLE "party_queue_claims" DROP CONSTRAINT "party_queue_claims_status_check";--> statement-breakpoint
ALTER TABLE "party_queue_claims" ADD CONSTRAINT "party_queue_claims_status_check" CHECK ("status" IN ('active', 'cancelling', 'cancelled', 'completed'));--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_loadout_revision_check" CHECK ("loadout_revision" >= 1);--> statement-breakpoint
ALTER TABLE "party_queue_claims" ADD CONSTRAINT "party_queue_claims_loadout_snapshots_check" CHECK (jsonb_typeof("loadout_snapshots") = 'array' AND (jsonb_array_length("loadout_snapshots") BETWEEN 1 AND 3 OR ("status" = 'cancelled' AND jsonb_array_length("loadout_snapshots") = 0)));
