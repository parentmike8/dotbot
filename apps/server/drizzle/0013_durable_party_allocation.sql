CREATE TABLE "parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"matchmaking_key" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"leader_player_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "party_members" (
	"party_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"guest_device_id" uuid,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "party_members_party_id_player_id_pk" PRIMARY KEY("party_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "party_queue_claims" (
	"id" uuid PRIMARY KEY NOT NULL,
	"party_id" uuid,
	"requesting_player_id" uuid NOT NULL,
	"party_version" integer NOT NULL,
	"build_id" text NOT NULL,
	"region" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "party_invite_acceptances" ADD COLUMN "guest_device_id" uuid;--> statement-breakpoint
ALTER TABLE "party_invite_acceptances" ADD COLUMN "durable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "party_invites" ADD COLUMN "party_id" uuid;--> statement-breakpoint
ALTER TABLE "party_invites" ADD COLUMN "roster_version" integer;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_leader_player_id_players_id_fk" FOREIGN KEY ("leader_player_id") REFERENCES "public"."players"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_members" ADD CONSTRAINT "party_members_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_members" ADD CONSTRAINT "party_members_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_members" ADD CONSTRAINT "party_members_guest_device_id_player_devices_id_fk" FOREIGN KEY ("guest_device_id") REFERENCES "public"."player_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_queue_claims" ADD CONSTRAINT "party_queue_claims_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_queue_claims" ADD CONSTRAINT "party_queue_claims_requesting_player_id_players_id_fk" FOREIGN KEY ("requesting_player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "parties_matchmaking_key_unique" ON "parties" USING btree ("matchmaking_key");--> statement-breakpoint
CREATE UNIQUE INDEX "party_members_player_unique" ON "party_members" USING btree ("player_id");--> statement-breakpoint
CREATE INDEX "party_queue_claims_party_status_idx" ON "party_queue_claims" USING btree ("party_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "party_queue_claims_requester_status_idx" ON "party_queue_claims" USING btree ("requesting_player_id","status","expires_at");--> statement-breakpoint
ALTER TABLE "party_invite_acceptances" ADD CONSTRAINT "party_invite_acceptances_guest_device_id_player_devices_id_fk" FOREIGN KEY ("guest_device_id") REFERENCES "public"."player_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_invites" ADD CONSTRAINT "party_invites_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_version_check" CHECK ("version" >= 1);--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_matchmaking_key_check" CHECK ("matchmaking_key" ~ '^party-[a-f0-9]{32}$');--> statement-breakpoint
ALTER TABLE "party_invites" ADD CONSTRAINT "party_invites_roster_binding_check" CHECK (("party_id" IS NULL AND "roster_version" IS NULL) OR ("party_id" IS NOT NULL AND "roster_version" IS NOT NULL AND "roster_version" >= 1));--> statement-breakpoint
ALTER TABLE "party_queue_claims" ADD CONSTRAINT "party_queue_claims_version_check" CHECK ("party_version" >= 1);--> statement-breakpoint
ALTER TABLE "party_queue_claims" ADD CONSTRAINT "party_queue_claims_status_check" CHECK ("status" IN ('active', 'cancelled'));--> statement-breakpoint
ALTER TABLE "party_queue_claims" ADD CONSTRAINT "party_queue_claims_metadata_check" CHECK (length("build_id") BETWEEN 1 AND 64 AND "build_id" ~ '^[a-zA-Z0-9._:-]+$' AND length("region") BETWEEN 1 AND 64 AND "region" ~ '^[a-zA-Z0-9._:-]+$');--> statement-breakpoint
CREATE FUNCTION "dotbot_enforce_party_member_cap"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  member_count integer;
BEGIN
  PERFORM 1 FROM "parties" WHERE "id" = NEW."party_id" FOR UPDATE;
  IF TG_OP = 'UPDATE' THEN
    SELECT count(*) INTO member_count FROM "party_members"
      WHERE "party_id" = NEW."party_id"
        AND NOT ("party_id" = OLD."party_id" AND "player_id" = OLD."player_id");
  ELSE
    SELECT count(*) INTO member_count FROM "party_members" WHERE "party_id" = NEW."party_id";
  END IF;
  IF member_count >= 3 THEN
    RAISE EXCEPTION 'party membership cap exceeded' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "party_members_cap_trigger" BEFORE INSERT OR UPDATE OF "party_id", "player_id" ON "party_members" FOR EACH ROW EXECUTE FUNCTION "dotbot_enforce_party_member_cap"();--> statement-breakpoint
CREATE FUNCTION "dotbot_validate_party_leader_from_party"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "parties" WHERE "id" = NEW."id")
    AND NOT EXISTS (
      SELECT 1 FROM "parties" p
      INNER JOIN "party_members" pm ON pm."party_id" = p."id" AND pm."player_id" = p."leader_player_id"
      WHERE p."id" = NEW."id"
    ) THEN
    RAISE EXCEPTION 'party leader must be a party member' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "dotbot_validate_party_leader_from_member"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "parties" WHERE "id" = OLD."party_id")
    AND NOT EXISTS (
      SELECT 1 FROM "parties" p
      INNER JOIN "party_members" pm ON pm."party_id" = p."id" AND pm."player_id" = p."leader_player_id"
      WHERE p."id" = OLD."party_id"
    ) THEN
    RAISE EXCEPTION 'party leader must be a party member' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."party_id" <> OLD."party_id"
    AND EXISTS (SELECT 1 FROM "parties" WHERE "id" = NEW."party_id")
    AND NOT EXISTS (
      SELECT 1 FROM "parties" p
      INNER JOIN "party_members" pm ON pm."party_id" = p."id" AND pm."player_id" = p."leader_player_id"
      WHERE p."id" = NEW."party_id"
    ) THEN
    RAISE EXCEPTION 'party leader must be a party member' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "parties_leader_member_trigger" AFTER INSERT OR UPDATE OF "leader_player_id" ON "parties" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "dotbot_validate_party_leader_from_party"();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "party_members_leader_member_trigger" AFTER DELETE OR UPDATE OF "party_id", "player_id" ON "party_members" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "dotbot_validate_party_leader_from_member"();--> statement-breakpoint
CREATE FUNCTION "dotbot_validate_guest_device_owner"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."guest_device_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "player_devices" WHERE "id" = NEW."guest_device_id" AND "player_id" = NEW."player_id"
  ) THEN
    RAISE EXCEPTION 'guest party membership device does not own player' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "party_members_guest_device_owner_trigger" BEFORE INSERT OR UPDATE OF "guest_device_id", "player_id" ON "party_members" FOR EACH ROW EXECUTE FUNCTION "dotbot_validate_guest_device_owner"();--> statement-breakpoint
CREATE TRIGGER "party_acceptances_guest_device_owner_trigger" BEFORE INSERT OR UPDATE OF "guest_device_id", "player_id" ON "party_invite_acceptances" FOR EACH ROW EXECUTE FUNCTION "dotbot_validate_guest_device_owner"();
