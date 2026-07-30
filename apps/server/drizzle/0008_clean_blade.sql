ALTER TABLE "players" ADD COLUMN "base_tutorial_phase" text DEFAULT 'complete' NOT NULL;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "base_tutorial_revision" integer DEFAULT 4 NOT NULL;
