CREATE TABLE "hold_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"item_type" text NOT NULL,
	"qty" integer NOT NULL,
	"acquired_match_id" uuid,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learned_blueprints" (
	"player_id" uuid NOT NULL,
	"blueprint_id" text NOT NULL,
	"learned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learned_blueprints_player_id_blueprint_id_pk" PRIMARY KEY("player_id","blueprint_id")
);
--> statement-breakpoint
CREATE TABLE "match_participants" (
	"match_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"extracted_manifest" jsonb,
	CONSTRAINT "match_participants_match_id_player_id_pk" PRIMARY KEY("match_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "match_results" (
	"id" uuid PRIMARY KEY NOT NULL,
	"room_code" text NOT NULL,
	"map_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"summary" jsonb
);
--> statement-breakpoint
CREATE TABLE "players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"device_token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hold_items" ADD CONSTRAINT "hold_items_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hold_items" ADD CONSTRAINT "hold_items_acquired_match_id_match_results_id_fk" FOREIGN KEY ("acquired_match_id") REFERENCES "public"."match_results"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learned_blueprints" ADD CONSTRAINT "learned_blueprints_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_participants" ADD CONSTRAINT "match_participants_match_id_match_results_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."match_results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_participants" ADD CONSTRAINT "match_participants_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "players_device_token_hash_unique" ON "players" USING btree ("device_token_hash");