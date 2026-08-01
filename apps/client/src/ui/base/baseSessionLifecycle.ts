import { isBaseTutorialComplete, type BaseTutorialState } from "@dotbot/game/baseTutorial";
import { createBaseMap } from "@dotbot/game/content/base";
import type {
  BaseLayout,
  BaseShellId,
  GameSnapshot,
  MapDocument,
  Vec2,
} from "@dotbot/game/types";
import type { BaseTutorialConnectionState } from "./BaseTutorialConnection";

export type BaseSessionWorld = {
  layout: BaseLayout;
  shell: BaseShellId;
  expanded: boolean;
  tutorial: BaseTutorialState;
};

export type ResolvedBaseSessionWorld = BaseSessionWorld & {
  authoritative: boolean;
  spawn: { position: Vec2; floorId: string } | null;
};

export function tutorialAuthorityToken(currentToken: string, storedToken: string | null): string {
  return storedToken || currentToken;
}

/**
 * Owns the single, explicit boundary between the server-run introduction and
 * the normal current-layout base.
 *
 * While authority is live, its initial world inputs remain frozen so phase
 * updates never recreate the simulation. Durable completion captures the exact
 * terminal player transform, retires authority, and makes every later map use
 * current layout/shell/expansion state.
 */
export class BaseSessionLifecycle {
  private initial: BaseSessionWorld;
  private authorityActive: boolean;
  private terminalTutorial: BaseTutorialState | null = null;
  private localSpawn: { position: Vec2; floorId: string } | null = null;

  constructor(initial: BaseSessionWorld, authoritative: boolean) {
    this.initial = {
      layout: { ...initial.layout },
      shell: initial.shell,
      expanded: initial.expanded,
      tutorial: { ...initial.tutorial },
    };
    this.authorityActive = authoritative;
  }

  get authoritative(): boolean {
    return this.authorityActive;
  }

  /** A fresh account can render one local frame while its durable base fetch
   * resolves. Promote that same mounted lifecycle when the storage link
   * arrives instead of leaving the introduction permanently local. */
  activateAuthoritative(initial: BaseSessionWorld): boolean {
    if (this.authorityActive || this.terminalTutorial || isBaseTutorialComplete(initial.tutorial)) return false;
    this.initial = {
      layout: { ...initial.layout },
      shell: initial.shell,
      expanded: initial.expanded,
      tutorial: { ...initial.tutorial },
    };
    this.localSpawn = null;
    this.authorityActive = true;
    return true;
  }

  acceptAuthoritative(state: BaseTutorialConnectionState): boolean {
    if (!this.authorityActive || !isBaseTutorialComplete(state.tutorial)) return false;
    const player = state.snapshot.bots.find((bot) => bot.id === "player");
    if (!player) throw new Error("Completed base introduction omitted the player.");
    this.terminalTutorial = { ...state.tutorial };
    this.localSpawn = {
      position: { ...player.position },
      floorId: player.floorId,
    };
    this.authorityActive = false;
    return true;
  }

  rememberLocalSnapshot(snapshot: GameSnapshot | null): void {
    if (this.authorityActive || !snapshot) return;
    const player = snapshot.bots.find((bot) => bot.id === "player");
    if (!player) return;
    this.localSpawn = {
      position: { ...player.position },
      floorId: player.floorId,
    };
  }

  world(current: BaseSessionWorld): ResolvedBaseSessionWorld {
    if (this.authorityActive) {
      return {
        ...this.initial,
        authoritative: true,
        spawn: null,
      };
    }
    return {
      ...current,
      tutorial: isBaseTutorialComplete(current.tutorial)
        ? current.tutorial
        : this.terminalTutorial ?? current.tutorial,
      authoritative: false,
      spawn: this.localSpawn
        ? {
            position: { ...this.localSpawn.position },
            floorId: this.localSpawn.floorId,
          }
        : null,
    };
  }

  createMap(current: BaseSessionWorld): MapDocument {
    const world = this.world(current);
    const map = createBaseMap(world.layout, world.shell, {
      expanded: world.expanded,
      tutorial: world.tutorial,
    });
    if (world.spawn) {
      const player = map.botSpawns.find((spawn) => spawn.id === "player");
      if (!player) throw new Error("Base map omitted the player spawn.");
      player.position = { ...world.spawn.position };
      player.floorId = world.spawn.floorId;
    }
    return map;
  }
}
