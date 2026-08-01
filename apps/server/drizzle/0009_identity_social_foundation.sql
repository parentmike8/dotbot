CREATE TABLE "external_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_verified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "friendships" (
	"player_low_id" uuid NOT NULL,
	"player_high_id" uuid NOT NULL,
	"requested_by_id" uuid NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	CONSTRAINT "friendships_player_low_id_player_high_id_pk" PRIMARY KEY("player_low_id","player_high_id")
);
--> statement-breakpoint
CREATE TABLE "identity_merge_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_player_id" uuid NOT NULL,
	"source_player_id" uuid NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"conflicts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_providers" (
	"external_identity_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"first_verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_providers_external_identity_id_provider_pk" PRIMARY KEY("external_identity_id","provider")
);
--> statement-breakpoint
CREATE TABLE "party_invite_acceptances" (
	"invite_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "party_invite_acceptances_invite_id_player_id_pk" PRIMARY KEY("invite_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "party_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"owner_player_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_blocks" (
	"blocker_player_id" uuid NOT NULL,
	"blocked_player_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_blocks_blocker_player_id_blocked_player_id_pk" PRIMARY KEY("blocker_player_id","blocked_player_id")
);
--> statement-breakpoint
CREATE TABLE "player_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "public_player_id" text;--> statement-breakpoint
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
		-- Same-candidate transactions serialize through commit, so an old service
		-- revision using this DEFAULT cannot race the uniqueness check.
		PERFORM pg_advisory_xact_lock(hashtextextended('dotbot-public-player-id:' || candidate, 0));
		IF NOT EXISTS (SELECT 1 FROM players WHERE public_player_id = candidate) THEN
			RETURN candidate;
		END IF;
	END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "players" ALTER COLUMN "public_player_id" SET DEFAULT dotbot_allocate_public_player_id();--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "discoverable_by_public_id" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_player_low_id_players_id_fk" FOREIGN KEY ("player_low_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_player_high_id_players_id_fk" FOREIGN KEY ("player_high_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_requested_by_id_players_id_fk" FOREIGN KEY ("requested_by_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_merge_receipts" ADD CONSTRAINT "identity_merge_receipts_target_player_id_players_id_fk" FOREIGN KEY ("target_player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_providers" ADD CONSTRAINT "identity_providers_external_identity_id_external_identities_id_fk" FOREIGN KEY ("external_identity_id") REFERENCES "public"."external_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_invite_acceptances" ADD CONSTRAINT "party_invite_acceptances_invite_id_party_invites_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."party_invites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_invite_acceptances" ADD CONSTRAINT "party_invite_acceptances_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_invites" ADD CONSTRAINT "party_invites_owner_player_id_players_id_fk" FOREIGN KEY ("owner_player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_blocks" ADD CONSTRAINT "player_blocks_blocker_player_id_players_id_fk" FOREIGN KEY ("blocker_player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_blocks" ADD CONSTRAINT "player_blocks_blocked_player_id_players_id_fk" FOREIGN KEY ("blocked_player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_devices" ADD CONSTRAINT "player_devices_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "external_identities_player_unique" ON "external_identities" USING btree ("player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "external_identities_issuer_subject_unique" ON "external_identities" USING btree ("issuer","subject");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_merge_source_external_unique" ON "identity_merge_receipts" USING btree ("source_player_id","issuer","subject");--> statement-breakpoint
CREATE UNIQUE INDEX "party_invites_token_hash_unique" ON "party_invites" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "player_devices_token_hash_unique" ON "player_devices" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "players_public_player_id_unique" ON "players" USING btree ("public_player_id");--> statement-breakpoint
DO $$
DECLARE
	player_row record;
	candidate text;
	alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	attempt integer;
	byte_index integer;
BEGIN
	FOR player_row IN SELECT id FROM players WHERE public_player_id IS NULL ORDER BY id LOOP
		attempt := 0;
		LOOP
			candidate := '';
			FOR byte_index IN 0..7 LOOP
				candidate := candidate || substr(
					alphabet,
					(get_byte(decode(md5(player_row.id::text || ':' || attempt::text), 'hex'), byte_index) % 32) + 1,
					1
				);
			END LOOP;
			BEGIN
				PERFORM pg_advisory_xact_lock(hashtextextended('dotbot-public-player-id:' || candidate, 0));
				UPDATE players SET public_player_id = candidate WHERE id = player_row.id;
				EXIT;
			EXCEPTION WHEN unique_violation THEN
				attempt := attempt + 1;
				IF attempt >= 64 THEN
					RAISE EXCEPTION 'Could not allocate a public player ID for %', player_row.id;
				END IF;
			END;
		END LOOP;
	END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "players" ALTER COLUMN "public_player_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_public_player_id_format" CHECK (public_player_id ~ '^[A-HJ-NP-Z2-9]{8}$');--> statement-breakpoint
INSERT INTO "player_devices" ("player_id", "token_hash", "created_at", "last_seen_at")
	SELECT "id", "device_token_hash", "created_at", "last_seen_at" FROM "players"
	ON CONFLICT ("token_hash") DO NOTHING;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_distinct_players" CHECK (player_low_id::text < player_high_id::text);--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_requester_in_pair" CHECK (requested_by_id = player_low_id OR requested_by_id = player_high_id);--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_status" CHECK (status IN ('pending', 'accepted'));--> statement-breakpoint
ALTER TABLE "player_blocks" ADD CONSTRAINT "player_blocks_distinct_players" CHECK (blocker_player_id <> blocked_player_id);--> statement-breakpoint
ALTER TABLE "identity_providers" ADD CONSTRAINT "identity_providers_supported" CHECK (provider IN ('email_link', 'phone'));
