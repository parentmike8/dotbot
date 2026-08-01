import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { defaultGameConfig } from "@dotbot/game/config";
import {
  BASE_SHELL_IDS,
  BASE_SLOT_DEFS,
  DEFAULT_BASE_SHELL,
  baseShellDef,
  isBaseObjectKind,
  isBaseShellId,
  isObjectAllowedInSlot,
  starterBaseLayout,
  validateBaseLayout,
} from "@dotbot/game/content/base";
import { RECIPES, SECOND_FLOOR_UPGRADE_ID, recipeById, type Recipe } from "@dotbot/game/content/recipes";
import { downtownMap } from "@dotbot/game/content/downtown";
import { contractDayStamp, contractObjectiveLabel, generateContractOffers } from "@dotbot/game/contracts";
import {
  BASE_TUTORIAL_FABRICATOR_ID,
  BASE_TUTORIAL_FABRICATOR_DOT_ID,
  initialBaseTutorialState,
  isBaseTutorialComplete,
  type BaseTutorialState,
} from "@dotbot/game/baseTutorial";
import type { BaseLayout, BaseObjectKind, BaseShellId, ContractDefinition, LoadoutPreset, WireLoadoutCode } from "@dotbot/game/types";
import { itemToCode, type WireItemCode } from "@dotbot/protocol";
import { useDotBotGame } from "../../game/useDotBotGame";
import { LocalSession } from "../../game/session/LocalSession";
import { BaseTutorialSession } from "../../game/session/BaseTutorialSession";
import { LobbyApp } from "../lobby/LobbyApp";
import { acceptPartyInvite, deviceTokenKey, ensureAccountToken, partyInviteCodeFromHash, playerNameKey } from "../identity";
import "./base.css";
import { advanceBaseChannel, findBaseTarget, type BaseChannelState, type BaseTarget } from "./baseFlow";
import type {
  BaseTutorialConnectionState,
  BaseTutorialConnectionStatus,
} from "./BaseTutorialConnection";
import {
  BaseSessionLifecycle,
  type BaseSessionWorld,
} from "./baseSessionLifecycle";
import { shouldPauseForBaseBootstrap } from "./baseBootstrap";

const localLayoutKey = "dotbot.baseLayout";
const localShellKey = "dotbot.baseShell";
const seedDraftedKey = "dotbot.baseSeedDrafted";
const channelDurationMs = 1000;

export type BasePayload = {
  storageLinked: boolean;
  tutorial: BaseTutorialState;
  shell: BaseShellId;
  upgrades: string[];
  layout: BaseLayout;
  stash: Array<{ itemType: WireItemCode; qty: number }>;
  learnedBlueprints: string[];
  loadout: WireItemCode[];
  stashCapacity: number;
  presets: LoadoutPreset[];
  insertionPreference: string | null;
  contractOffers: ContractDefinition[];
  activeContracts: ContractDefinition[];
};

type Panel =
  | { type: "locker" | "bayConsole" | "fabricator" | "planningTable" | "draftingTable"; slotId: string }
  | { type: "move"; fromSlotId?: string; toSlotId?: string }
  | { type: "fabricateSlot"; recipeId: string }
  | { type: "object"; slotId: string; kind: BaseObjectKind }
  | null;

const offlinePayload: BasePayload = {
  storageLinked: false,
  tutorial: initialBaseTutorialState,
  shell: DEFAULT_BASE_SHELL,
  upgrades: [],
  layout: starterBaseLayout,
  stash: [],
  learnedBlueprints: [],
  loadout: [],
  stashCapacity: 40,
  presets: [],
  insertionPreference: null,
  contractOffers: generateContractOffers(downtownMap, "offline", contractDayStamp()),
  activeContracts: [],
};

export function BaseApp() {
  const [name, setName] = useState(() => localStorage.getItem(playerNameKey) ?? "");
  const [identityReady, setIdentityReady] = useState(() => Boolean(localStorage.getItem(playerNameKey)));
  const [baseReady, setBaseReady] = useState(() => !localStorage.getItem(playerNameKey));
  const [base, setBase] = useState<BasePayload>(() => ({
    ...offlinePayload,
    tutorial: { ...initialBaseTutorialState },
    layout: readLocalLayout(),
    shell: readLocalShell(),
  }));
  const [panel, setPanel] = useState<Panel>(null);
  const [deployment, setDeployment] = useState(() => /^#\/r\/[A-Z2-9]{4}(?:\?squad=[a-z0-9-]+)?$/i.test(window.location.hash) || window.location.hash === "#/lobby");
  const [notice, setNotice] = useState("");
  const pendingPartyInvite = useRef(partyInviteCodeFromHash(window.location.hash));
  const [draftObjectIds, setDraftObjectIds] = useState<string[]>(() => localStorage.getItem(seedDraftedKey)
    ? []
    : Object.keys(readLocalLayout()).map((slotId) => `base-object-${slotId}`));

  useEffect(() => {
    // Fragments never reach the server, but the invite is still a bearer. Drop
    // it from the visible URL/history entry after capturing it for one attempt.
    if (pendingPartyInvite.current) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
  }, []);

  const refreshBase = useCallback(async () => {
    const token = localStorage.getItem(deviceTokenKey);
    if (!token) return;
    setBaseReady(false);
    try {
      const response = await fetch("/api/base", { headers: { "x-device-token": token } });
      if (!response.ok) throw new Error(`Base fetch failed (${response.status})`);
      const payload = await response.json() as BasePayload;
      const next = {
        ...payload,
        tutorial: payload.tutorial,
        upgrades: Array.isArray(payload.upgrades) ? payload.upgrades : [],
        layout: payload.storageLinked ? { ...payload.layout } : readLocalLayout(),
        // Never trust the wire for the shell id — a bad value would sink the
        // whole base session at render time.
        shell: payload.storageLinked && isBaseShellId(payload.shell) ? payload.shell : readLocalShell(),
      };
      setBase(next);
      localStorage.setItem(localLayoutKey, JSON.stringify(next.layout));
      localStorage.setItem(localShellKey, next.shell);
      setNotice("");
    } catch {
      setBase((current) => ({
        ...current,
        storageLinked: false,
        tutorial: { ...initialBaseTutorialState },
        layout: readLocalLayout(),
        shell: readLocalShell(),
      }));
    } finally {
      setBaseReady(true);
    }
  }, []);

  const acceptTutorialState = useCallback((state: BaseTutorialConnectionState) => {
    setBase((current) => current.tutorial.phase === state.tutorial.phase
      && current.tutorial.revision === state.tutorial.revision
      ? current
      : { ...current, tutorial: state.tutorial });
    setNotice("");
  }, []);

  useEffect(() => {
    if (!identityReady) return;
    const storedName = localStorage.getItem(playerNameKey) ?? name;
    void ensureAccountToken(storedName).then(async () => {
      // The invite is an independent bootstrap sidecar. Start the base refresh
      // without making a slow account/base read delay invite acceptance.
      void refreshBase();
      const code = pendingPartyInvite.current;
      if (!code) return;
      pendingPartyInvite.current = null;
      try {
        const accepted = await acceptPartyInvite(code);
        setNotice(accepted.durable
          ? `PARTY INVITE ACCEPTED FROM ${accepted.inviter.displayName}`
          : `PARTY INVITE ACCEPTED FROM ${accepted.inviter.displayName} · LINK AN ACCOUNT TO KEEP IT`);
      } catch (error) {
        setNotice(error instanceof Error ? error.message.toUpperCase() : "PARTY INVITE COULD NOT BE ACCEPTED");
      }
    }).catch(() => {
      setBaseReady(true);
      setBase((current) => ({ ...current, storageLinked: false }));
    });
  }, [identityReady, name, refreshBase]);

  const finishIdentity = (event: FormEvent) => {
    event.preventDefault();
    const clean = name.trim().replace(/\s+/g, " ").slice(0, 24);
    if (!clean) return;
    localStorage.setItem(playerNameKey, clean);
    setName(clean);
    // A callsign is enough to enter the local base. Authoritative guest
    // registration happens in the existing bootstrap effect and never gates
    // movement on a network round trip.
    setIdentityReady(true);
  };

  const updateLayout = useCallback(async (nextLayout: BaseLayout, draftObjectId?: string) => {
    localStorage.setItem(localLayoutKey, JSON.stringify(nextLayout));
    setBase((current) => ({ ...current, layout: nextLayout }));
    if (draftObjectId) setDraftObjectIds([draftObjectId]);
    setPanel(null);
    const token = localStorage.getItem(deviceTokenKey);
    if (!token) return;
    try {
      const response = await fetch("/api/base/layout", {
        method: "POST",
        headers: { "content-type": "application/json", "x-device-token": token },
        body: JSON.stringify({ layout: nextLayout }),
      });
      if (!response.ok) throw new Error(`Layout update failed (${response.status})`);
      const payload = await response.json() as { layout: BaseLayout };
      localStorage.setItem(localLayoutKey, JSON.stringify(payload.layout));
    } catch {
      setBase((current) => ({ ...current, storageLinked: false }));
      setNotice("LAYOUT SAVED TO THIS DEVICE");
    }
  }, []);

  const updateShell = useCallback(async (shell: BaseShellId) => {
    if (!Object.values(base.layout).includes("draftingTable")) {
      setNotice("REQUIRES DRAFTING TABLE");
      return;
    }
    const previousShell = base.shell;
    localStorage.setItem(localShellKey, shell);
    if (shell !== base.shell) {
      // Moving shells re-drafts the whole base: every placed object queues
      // through the same draw-on used for fabrication.
      setDraftObjectIds(Object.keys(base.layout).map((slotId) => `base-object-${slotId}`));
      setBase((current) => ({ ...current, shell }));
      setPanel(null);
    }
    const token = localStorage.getItem(deviceTokenKey);
    if (!token) {
      localStorage.setItem(localShellKey, previousShell);
      setBase((current) => ({ ...current, shell: previousShell }));
      setNotice("STORAGE LINK REQUIRED");
      return;
    }
    try {
      const response = await fetch("/api/base/shell", {
        method: "POST",
        headers: { "content-type": "application/json", "x-device-token": token },
        body: JSON.stringify({ shell }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Base layout update failed (${response.status})`);
      setNotice("");
    } catch (error) {
      localStorage.setItem(localShellKey, previousShell);
      setBase((current) => ({ ...current, shell: previousShell }));
      setNotice(error instanceof Error ? error.message.toUpperCase() : "BASE LAYOUT NOT SAVED");
    }
  }, [base.shell, base.layout]);

  const updateLoadout = useCallback(async (loadout: WireItemCode[]) => {
    if (!base.storageLinked) return;
    const token = localStorage.getItem(deviceTokenKey);
    if (!token) return;
    try {
      const response = await fetch("/api/base/loadout", {
        method: "POST",
        headers: { "content-type": "application/json", "x-device-token": token },
        body: JSON.stringify({ loadout }),
      });
      const body = await response.json() as BasePayload & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Loadout update failed (${response.status})`);
      setBase((current) => ({ ...body, layout: current.layout }));
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message.toUpperCase() : "LOADOUT UPDATE FAILED");
    }
  }, [base.storageLinked]);

  const fabricate = useCallback(async (recipeId: string, slotId?: string) => {
    if (!base.storageLinked) return;
    const token = localStorage.getItem(deviceTokenKey);
    if (!token) return;
    try {
      const response = await fetch("/api/base/fabricate", {
        method: "POST",
        headers: { "content-type": "application/json", "x-device-token": token },
        body: JSON.stringify({ recipeId, slotId }),
      });
      const body = await response.json() as BasePayload & { error?: string; fabricated?: { output: Recipe["output"]; slotId?: string } };
      if (!response.ok || !body.fabricated) throw new Error(body.error ?? `Fabrication failed (${response.status})`);
      if (body.fabricated.output.kind === "furniture" && body.fabricated.slotId) {
        localStorage.setItem(localLayoutKey, JSON.stringify(body.layout));
        setBase(body);
        setDraftObjectIds([`base-object-${body.fabricated.slotId}`]);
        setPanel(null);
        setNotice(`FABRICATED ${objectName(body.fabricated.output.objectKind)} · ${body.fabricated.slotId}`);
      } else if (body.fabricated.output.kind === "expansion") {
        localStorage.setItem(localLayoutKey, JSON.stringify(body.layout));
        setBase(body);
        setDraftObjectIds([baseShellDef(body.shell).upper.stairs.ground.id]);
        setPanel(null);
        setNotice("FLOOR 1 COMMISSIONED");
      } else {
        setBase((current) => ({ ...body, layout: current.layout }));
        const outputCode = body.fabricated.output.kind === "item" ? itemToCode(body.fabricated.output.item) : null;
        setNotice(outputCode ? `FABRICATED ${wireItemName(outputCode)} → STASH` : "FABRICATION COMPLETE");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message.toUpperCase() : "FABRICATION FAILED");
    }
  }, [base.storageLinked]);

  const savePresets = useCallback(async (presets: LoadoutPreset[]) => {
    if (!base.storageLinked) return;
    const token = localStorage.getItem(deviceTokenKey);
    if (!token) return;
    try {
      const response = await fetch("/api/base/presets", {
        method: "POST",
        headers: { "content-type": "application/json", "x-device-token": token },
        body: JSON.stringify({ presets }),
      });
      const body = await response.json() as BasePayload & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Preset save failed (${response.status})`);
      setBase((current) => ({ ...body, layout: current.layout }));
      setNotice("PRESETS SAVED");
    } catch (error) {
      setNotice(error instanceof Error ? error.message.toUpperCase() : "PRESET SAVE FAILED");
    }
  }, [base.storageLinked]);

  const applyPreset = useCallback(async (presetIndex: number) => {
    if (!base.storageLinked) return;
    const token = localStorage.getItem(deviceTokenKey);
    if (!token) return;
    try {
      const response = await fetch("/api/base/presets/apply", {
        method: "POST",
        headers: { "content-type": "application/json", "x-device-token": token },
        body: JSON.stringify({ presetIndex }),
      });
      const body = await response.json() as BasePayload & { error?: string; missing?: Array<{ itemType: WireLoadoutCode; qty: number }> };
      if (!response.ok) throw new Error(body.error ?? `Preset apply failed (${response.status})`);
      setBase((current) => ({ ...body, layout: current.layout }));
      const missing = body.missing ?? [];
      setNotice(missing.length
        ? `PRESET PARTIALLY APPLIED · MISSING ${missing.map((entry) => `${entry.qty}× ${wireItemName(entry.itemType)}`).join(" · ")}`
        : "PRESET APPLIED");
    } catch (error) {
      setNotice(error instanceof Error ? error.message.toUpperCase() : "PRESET APPLY FAILED");
    }
  }, [base.storageLinked]);

  const updateInsertionPreference = useCallback(async (insertionPointId: string | null) => {
    if (!base.storageLinked) return;
    const token = localStorage.getItem(deviceTokenKey);
    if (!token) return;
    try {
      const response = await fetch("/api/base/insertion", {
        method: "POST",
        headers: { "content-type": "application/json", "x-device-token": token },
        body: JSON.stringify({ insertionPointId }),
      });
      const body = await response.json() as { insertionPreference?: string | null; error?: string };
      if (!response.ok) throw new Error(body.error ?? `Insertion preference failed (${response.status})`);
      setBase((current) => ({ ...current, insertionPreference: body.insertionPreference ?? null }));
      const point = downtownMap.insertionPoints.find((candidate) => candidate.id === body.insertionPreference);
      setNotice(point ? `INSERTION PREFERENCE: ${point.name}` : "INSERTION PREFERENCE CLEARED");
    } catch (error) {
      setNotice(error instanceof Error ? error.message.toUpperCase() : "INSERTION PREFERENCE FAILED");
    }
  }, [base.storageLinked]);

  const updateContracts = useCallback(async (action: "accept" | "reroll" | "abandon", contractId?: string) => {
    if (!base.storageLinked) return;
    const token = localStorage.getItem(deviceTokenKey);
    if (!token) return;
    try {
      const response = await fetch(`/api/base/contracts/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-device-token": token },
        body: JSON.stringify(contractId ? { contractId } : {}),
      });
      const body = await response.json() as BasePayload & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Contract ${action} failed (${response.status})`);
      setBase((current) => ({ ...body, layout: current.layout }));
      setNotice(action === "accept" ? "CONTRACT ACCEPTED" : action === "abandon" ? "CONTRACT ABANDONED" : "CONTRACT OFFERS REROLLED");
    } catch (error) {
      setNotice(error instanceof Error ? error.message.toUpperCase() : "CONTRACT LINK FAILED");
    }
  }, [base.storageLinked]);

  if (shouldPauseForBaseBootstrap(identityReady, baseReady)) {
    return <BaseLinkState message="LINKING AUTHORITATIVE BASE · MOVEMENT PAUSED" />;
  }

  if (deployment && isBaseTutorialComplete(base.tutorial)) {
    return <LobbyApp embedded onReturnToBase={() => {
      setDeployment(false);
      setPanel(null);
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      void refreshBase();
    }} />;
  }

  return (
    <BaseSession
      base={base}
      identityReady={identityReady}
      name={name}
      notice={notice}
      panel={panel}
      setName={setName}
      finishIdentity={finishIdentity}
      setPanel={setPanel}
      openDeployment={() => {
        setPanel(null);
        setDeployment(true);
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#/lobby`);
      }}
      updateLayout={updateLayout}
      updateShell={updateShell}
      draftObjectIds={draftObjectIds}
      onDraftQueued={() => {
        localStorage.setItem(seedDraftedKey, "1");
        setDraftObjectIds([]);
      }}
      updateLoadout={updateLoadout}
      fabricate={fabricate}
      savePresets={savePresets}
      applyPreset={applyPreset}
      updateInsertionPreference={updateInsertionPreference}
      updateContracts={updateContracts}
      acceptTutorialState={acceptTutorialState}
      reportTutorialError={setNotice}
    />
  );
}

function BaseLinkState({ message }: { message: string }) {
  return (
    <main
      className="base-shell"
      aria-label="DotBot persistent base"
      data-authority="server"
      data-authority-status="disconnected"
    >
      <section className="base-panel identity-panel" role="status" aria-live="polite">
        <header><span>HOME BAY / LINK</span><strong>BASE PAUSED</strong></header>
        <p>{message}</p>
      </section>
    </main>
  );
}

type BaseSessionProps = {
  base: BasePayload;
  identityReady: boolean;
  name: string;
  notice: string;
  panel: Panel;
  setName: (value: string) => void;
  finishIdentity: (event: FormEvent) => void;
  setPanel: (panel: Panel) => void;
  openDeployment: () => void;
  updateLayout: (layout: BaseLayout, draftObjectId?: string) => Promise<void>;
  updateShell: (shell: BaseShellId) => Promise<void>;
  draftObjectIds: string[];
  onDraftQueued: () => void;
  updateLoadout: (loadout: WireItemCode[]) => Promise<void>;
  fabricate: (recipeId: string, slotId?: string) => Promise<void>;
  savePresets: (presets: LoadoutPreset[]) => Promise<void>;
  applyPreset: (presetIndex: number) => Promise<void>;
  updateInsertionPreference: (insertionPointId: string | null) => Promise<void>;
  updateContracts: (action: "accept" | "reroll" | "abandon", contractId?: string) => Promise<void>;
  acceptTutorialState: (state: BaseTutorialConnectionState) => void;
  reportTutorialError: (message: string) => void;
};

function BaseSession(props: BaseSessionProps) {
  const tutorialComplete = isBaseTutorialComplete(props.base.tutorial);
  const initialTutorialRef = useRef(props.base.tutorial);
  const lifecycleRef = useRef<BaseSessionLifecycle | null>(null);
  if (!lifecycleRef.current) {
    lifecycleRef.current = new BaseSessionLifecycle({
      layout: props.base.layout,
      shell: tutorialComplete ? props.base.shell : "workshop",
      expanded: tutorialComplete && ownsSecondFloor(props.base),
      tutorial: props.base.tutorial,
    }, props.identityReady && props.base.storageLinked && !tutorialComplete);
  }
  const lifecycle = lifecycleRef.current;
  const [, setLifecycleRevision] = useState(0);
  const tutorialTokenRef = useRef(localStorage.getItem(deviceTokenKey) ?? "");
  const tutorialInteractRef = useRef(false);
  const [authorityStatus, setAuthorityStatus] = useState<BaseTutorialConnectionStatus>(
    lifecycle.authoritative ? "connecting" : "connected",
  );
  const currentWorld: BaseSessionWorld = {
    layout: props.base.layout,
    shell: props.base.shell,
    expanded: ownsSecondFloor(props.base),
    tutorial: props.base.tutorial,
  };
  const resolvedWorld = lifecycle.world(currentWorld);
  // The carried transform seeds a rebuild but must not cause one: local movement
  // updates it every HUD frame. Layout/shell/expansion/terminal authority are the
  // only world-identity changes that replace both renderer and collision state.
  const map = useMemo(() => lifecycle.createMap(currentWorld), [
    lifecycle,
    resolvedWorld.authoritative,
    resolvedWorld.expanded,
    resolvedWorld.layout,
    resolvedWorld.shell,
    resolvedWorld.tutorial.phase,
    resolvedWorld.tutorial.revision,
  ]);
  const session = useMemo(() => resolvedWorld.authoritative
    ? new BaseTutorialSession({
        map,
        token: tutorialTokenRef.current,
        interactionIntent: () => tutorialInteractRef.current,
        onState: (state) => {
          props.acceptTutorialState(state);
          if (lifecycle.acceptAuthoritative(state)) {
            setAuthorityStatus("connected");
            setLifecycleRevision((revision) => revision + 1);
          }
        },
        onConnectionState: (status) => {
          setAuthorityStatus(status);
          if (status === "connecting") props.reportTutorialError("BASE LINK CONNECTING · MOVEMENT PAUSED");
          if (status === "disconnected") props.reportTutorialError("BASE LINK LOST · MOVEMENT PAUSED");
        },
        onError: props.reportTutorialError,
      })
    : new LocalSession({
        map,
        config: {
          ...defaultGameConfig,
          runDurationMs: Number.MAX_SAFE_INTEGER,
          damageSpeed: 250,
          dashSpeed: 760,
        },
        playerId: "player",
      }), [map]);
  const {
    hostRef,
    snapshot,
    playerId,
    setInteractionChannel,
    draftObjects,
    setMapObjectEnabled,
    setInteractionDotsVisible,
    setPlacementSlotsVisible,
    joystick,
    joystickHandlers,
    queueDash,
  } = useDotBotGame({ session });
  const player = snapshot?.bots.find((bot) => bot.id === playerId);
  lifecycle.rememberLocalSnapshot(snapshot);
  const dashProgress = player
    ? 1 - Math.max(0, Math.min(1, player.dashCooldownMs / defaultGameConfig.dashCooldownMs))
    : 1;
  const channelRef = useRef<BaseChannelState | null>(null);
  const previousTutorialPhaseRef = useRef(initialTutorialRef.current.phase);

  useEffect(() => {
    if (props.draftObjectIds.length === 0) return;
    draftObjects(props.draftObjectIds);
    props.onDraftQueued();
  }, [draftObjects, props]);

  useEffect(() => {
    const phase = props.base.tutorial.phase;
    setMapObjectEnabled(
      BASE_TUTORIAL_FABRICATOR_ID,
      phase === "fabricator" || phase === "doorOpen",
    );
    setInteractionDotsVisible(
      phase === "fabricator"
        ? new Set([BASE_TUTORIAL_FABRICATOR_DOT_ID])
        : phase === "complete"
          ? new Set(map.interactionDots
            ?.filter((dot) => dot.id !== BASE_TUTORIAL_FABRICATOR_DOT_ID)
            .map((dot) => dot.id) ?? [])
          : new Set(),
    );
    setPlacementSlotsVisible(phase === "complete");
    if (phase === "fabricator" && previousTutorialPhaseRef.current !== "fabricator") {
      draftObjects([BASE_TUTORIAL_FABRICATOR_ID]);
    }
    previousTutorialPhaseRef.current = phase;
  }, [
    draftObjects,
    map.interactionDots,
    props.base.tutorial.phase,
    setMapObjectEnabled,
    setInteractionDotsVisible,
    setPlacementSlotsVisible,
  ]);

  const openTarget = useCallback((target: BaseTarget) => {
    if (target.type === "tutorialFabricator") return;
    if (target.type === "deployment") {
      props.openDeployment();
      return;
    }
    if (target.type === "emptySlot") {
      props.setPanel({ type: "move", toSlotId: target.slot.id });
      return;
    }
    const kind = target.object.kind;
    if (kind === "locker" || kind === "bayConsole" || kind === "fabricator" || kind === "planningTable" || kind === "draftingTable") {
      props.setPanel({ type: kind, slotId: target.object.slotId! });
    } else if (target.object.slotId && isBaseObjectKind(kind)) {
      props.setPanel({ type: "object", slotId: target.object.slotId, kind });
    }
  }, [props]);

  useEffect(() => {
    if (!snapshot || !player || !props.identityReady || props.panel) {
      tutorialInteractRef.current = false;
      setInteractionChannel(null);
      return;
    }
    const candidate = findBaseTarget(map, player.position, player.floorId);
    const target = tutorialTargetForPhase(candidate, props.base.tutorial.phase);
    tutorialInteractRef.current = target?.type === "tutorialFabricator";
    const advanced = advanceBaseChannel(channelRef.current, target, player.position, snapshot.timeMs, channelDurationMs);
    channelRef.current = advanced.state;
    setInteractionChannel(target && advanced.progress !== null
      ? { position: target.center, radius: target.dot.radius + 8, progress: advanced.progress }
      : null);
    if (advanced.completed) openTarget(advanced.completed);
  }, [
    map,
    openTarget,
    player,
    props.base.tutorial.phase,
    props.identityReady,
    props.panel,
    setInteractionChannel,
    snapshot,
  ]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __dotbotBase?: unknown }).__dotbotBase = {
      storageLinked: props.base.storageLinked,
      layout: props.base.layout,
      upgrades: props.base.upgrades,
      panel: props.panel?.type ?? null,
      tutorial: props.base.tutorial,
      playerPosition: player?.position ?? null,
      playerFloorId: player?.floorId ?? null,
    };
  }, [player, props.base, props.panel]);

  return (
    <main
      className="base-shell"
      aria-label="DotBot persistent base"
      data-storage-linked={props.base.storageLinked}
      data-player-x={player ? Math.round(player.position.x) : undefined}
      data-player-y={player ? Math.round(player.position.y) : undefined}
      data-player-floor={player?.floorId}
      data-panel={props.panel?.type ?? "none"}
      data-tutorial={props.base.tutorial.phase}
      data-session-stable="true"
      data-authority={resolvedWorld.authoritative ? "server" : "local"}
      data-authority-status={authorityStatus}
    >
      <div ref={hostRef} className="game-canvas" />
      <header className="base-title-block">
        <span>DOTBOT / HOME BAY</span>
        <strong>{props.name || "UNCOMMISSIONED"}</strong>
        <small>{props.base.storageLinked ? "STORAGE LINK ACTIVE" : "OFFLINE — NO STORAGE LINK"}</small>
      </header>
      {props.identityReady && !props.panel && !tutorialComplete ? (
        <aside className="base-onboarding" role="status" aria-live="polite">
          <span>{tutorialStepLabel(props.base.tutorial.phase)}</span>
          <strong>{tutorialInstruction(props.base.tutorial.phase)}</strong>
          {props.base.tutorial.phase === "movement" ? <>
            <p className="base-onboarding-keyboard">USE <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> OR THE ARROW KEYS</p>
            <p className="base-onboarding-touch">DRAG THE JOYSTICK</p>
          </> : props.base.tutorial.phase === "practice"
            ? <p>DASH IS YOUR ATTACK · THE PRACTICE BOT CANNOT HURT YOU</p>
            : props.base.tutorial.phase === "fabricator"
              ? <p>STAND STILL ON THE MARK · THE FABRICATOR BUILDS WHAT YOU EARN</p>
              : <p>REPAIR DOTS RESTORE A BROKEN PLATE · CARRY THEM IN A BAY</p>}
        </aside>
      ) : null}
      {tutorialComplete ? <div className="base-instruction">STASH STORES · BAYS CARRY · BUILD AT FABRICATOR · DEPLOY AT DOOR</div> : null}
      {props.identityReady && !props.panel ? (
        <div className="touch-controls base-touch-controls" aria-label="Touch controls">
          <div
            className={`joystick ${joystick.active ? "active" : ""}`}
            role="application"
            aria-label="Movement joystick"
            aria-disabled={resolvedWorld.authoritative && authorityStatus !== "connected"}
            {...joystickHandlers}
          >
            <span
              className="joystick-knob"
              style={{ transform: `translate(${joystick.knob.x}px, ${joystick.knob.y}px)` }}
            />
          </div>
          <button
            className="dash-button"
            type="button"
            onPointerDown={(event) => {
              event.preventDefault();
              queueDash();
            }}
            style={{ "--dash-progress": dashProgress } as CSSProperties}
            disabled={
              !player
              || player.state !== "alive"
              || (resolvedWorld.authoritative && authorityStatus !== "connected")
              || (player.dashCooldownMs > 0 && player.dashOverchargeCharges <= 0)
            }
            aria-label="Dash"
          >
            Dash
          </button>
        </div>
      ) : null}
      {props.notice ? <div className="base-notice">{props.notice}</div> : null}
      {!props.identityReady ? (
        <section className="base-panel identity-panel" aria-label="Choose callsign">
          <header><span>HOME BAY / COMMISSION</span><strong>CALLSIGN</strong></header>
          <form onSubmit={props.finishIdentity}>
            <label>NAME<input autoFocus maxLength={24} value={props.name} onChange={(event) => props.setName(event.target.value)} /></label>
            <button type="submit">ENTER BASE</button>
          </form>
        </section>
      ) : null}
      {props.panel ? (
        <BasePanel
          panel={props.panel}
          base={props.base}
          close={() => props.setPanel(null)}
          move={(fromSlotId, toSlotId) => props.updateLayout(moveObject(props.base.layout, fromSlotId, toSlotId), `base-object-${toSlotId}`)}
          chooseMove={(next) => props.setPanel(next)}
          updateLoadout={props.updateLoadout}
          updateShell={props.updateShell}
          notice={props.notice}
          fabricate={props.fabricate}
          savePresets={props.savePresets}
          applyPreset={props.applyPreset}
          updateInsertionPreference={props.updateInsertionPreference}
          updateContracts={props.updateContracts}
        />
      ) : null}
    </main>
  );
}

function BasePanel({ panel, base, close, move, chooseMove, updateLoadout, updateShell, notice, fabricate, savePresets, applyPreset, updateInsertionPreference, updateContracts }: {
  panel: Exclude<Panel, null>;
  base: BasePayload;
  close: () => void;
  move: (fromSlotId: string, toSlotId: string) => void;
  chooseMove: (panel: Exclude<Panel, null>) => void;
  updateLoadout: (loadout: WireItemCode[]) => Promise<void>;
  updateShell: (shell: BaseShellId) => Promise<void>;
  notice: string;
  fabricate: (recipeId: string, slotId?: string) => Promise<void>;
  savePresets: (presets: LoadoutPreset[]) => Promise<void>;
  applyPreset: (presetIndex: number) => Promise<void>;
  updateInsertionPreference: (insertionPointId: string | null) => Promise<void>;
  updateContracts: (action: "accept" | "reroll" | "abandon", contractId?: string) => Promise<void>;
}) {
  if (panel.type === "move") {
    return <MovePanel panel={panel} base={base} close={close} move={move} />;
  }
  if (panel.type === "draftingTable") {
    return <ShellPanel
      current={base.shell}
      expanded={ownsSecondFloor(base)}
      storageLinked={base.storageLinked}
      close={close}
      updateShell={updateShell}
      move={() => chooseMove({ type: "move", fromSlotId: panel.slotId })}
    />;
  }
  if (panel.type === "fabricateSlot") {
    return <FabricationSlotPanel panel={panel} base={base} close={close} fabricate={fabricate} />;
  }
  if (panel.type === "object") {
    return <ObjectPanel panel={panel} close={close} chooseMove={chooseMove} />;
  }
  const title = panel.type === "bayConsole" ? "BAY CONSOLE" : panel.type.replace(/([A-Z])/g, " $1").toUpperCase();
  return (
    <section className="base-panel" aria-label={`${title} panel`}>
      <header><span>HOME BAY / OBJECT</span><strong>{title}</strong><button type="button" onClick={close}>×</button></header>
      {!base.storageLinked && (panel.type === "locker" || panel.type === "bayConsole" || panel.type === "fabricator" || panel.type === "planningTable") ? <p className="offline-hint">OFFLINE — NO STORAGE LINK</p> : null}
      {panel.type === "locker" ? <>
        <h2>STASH {stashCount(base.stash)}/{base.stashCapacity}</h2><ItemCounts items={base.stash} />
        <h2>LEARNED BLUEPRINTS</h2><p>{base.learnedBlueprints.length ? base.learnedBlueprints.join(" · ") : "NONE YET"}</p>
      </> : null}
      {panel.type === "bayConsole" ? <BayConsolePanel base={base} updateLoadout={updateLoadout} savePresets={savePresets} applyPreset={applyPreset} notice={notice} /> : null}
      {panel.type === "fabricator" ? <FabricatorPanel base={base} notice={notice} chooseRecipe={(recipe) => {
        if (recipe.output.kind === "furniture") chooseMove({ type: "fabricateSlot", recipeId: recipe.id });
        else void fabricate(recipe.id);
      }} /> : null}
      {panel.type === "planningTable" ? <PlanningTablePanel base={base} updateInsertionPreference={updateInsertionPreference} updateContracts={updateContracts} /> : null}
      <footer><button type="button" onClick={() => chooseMove({ type: "move", fromSlotId: panel.slotId })}>MOVE</button></footer>
    </section>
  );
}

function PlanningTablePanel({ base, updateInsertionPreference, updateContracts }: {
  base: BasePayload;
  updateInsertionPreference: (insertionPointId: string | null) => Promise<void>;
  updateContracts: (action: "accept" | "reroll" | "abandon", contractId?: string) => Promise<void>;
}) {
  const selected = downtownMap.insertionPoints.find((point) => point.id === base.insertionPreference);
  return <>
    <h2>INSERTION: {selected?.name ?? "NO PREFERENCE"}</h2>
    <svg className="insertion-map" viewBox={`0 0 ${downtownMap.width} ${downtownMap.height}`} role="img" aria-label="Downtown insertion preference map">
      <rect x={0} y={0} width={downtownMap.width} height={downtownMap.height} fill="none" stroke="currentColor" strokeWidth={24} />
      {downtownMap.outdoor.roads.map((road) => <rect key={road.id} x={road.x} y={road.y} width={road.w} height={road.h} fill="currentColor" opacity={0.08} />)}
      {downtownMap.buildings.map((building) => <rect key={building.id} x={building.footprint.x} y={building.footprint.y} width={building.footprint.w} height={building.footprint.h} fill="currentColor" opacity={0.18} />)}
      {downtownMap.insertionPoints.map((point) => <g key={point.id} className={point.id === base.insertionPreference ? "is-selected" : ""}>
        <circle cx={point.position.x} cy={point.position.y} r={46} fill="white" stroke="currentColor" strokeWidth={18} />
        <circle cx={point.position.x} cy={point.position.y} r={point.id === base.insertionPreference ? 22 : 12} fill="currentColor" />
      </g>)}
    </svg>
    <div className="insertion-choices">
      {downtownMap.insertionPoints.map((point) => <button
        type="button"
        key={point.id}
        className={point.id === base.insertionPreference ? "is-selected" : ""}
        disabled={!base.storageLinked}
        aria-pressed={point.id === base.insertionPreference}
        onClick={() => void updateInsertionPreference(point.id === base.insertionPreference ? null : point.id)}
      >{point.name}</button>)}
    </div>
    <p>PREFERENCE, NOT PICK · SQUAD SPACING OVERRIDES EVERY VOTE</p>
    <div className="contract-heading"><h2>OFFERS</h2><button type="button" disabled={!base.storageLinked} onClick={() => void updateContracts("reroll")}>REROLL</button></div>
    <div className="contract-list">
      {base.contractOffers.map((contract) => <article className="contract-card" key={contract.id}>
        <strong>{contract.title}</strong>
        <small>{contractObjectiveLabel(contract, downtownMap)}</small>
        <span>PAY · {contract.payout.items.map((item) => wireItemGlyph(itemToCode(item))).join(" ")}</span>
        <button type="button" disabled={!base.storageLinked || base.activeContracts.length >= 2} onClick={() => void updateContracts("accept", contract.id)}>ACCEPT</button>
      </article>)}
    </div>
    <h2>ACTIVE {base.activeContracts.length}/2</h2>
    <div className="contract-list">
      {base.activeContracts.map((contract) => <article className="contract-card is-active" key={contract.id}>
        <strong>{contract.title}</strong><small>{contractObjectiveLabel(contract, downtownMap)}</small>
        <button type="button" disabled={!base.storageLinked} onClick={() => void updateContracts("abandon", contract.id)}>ABANDON</button>
      </article>)}
      {base.activeContracts.length === 0 ? <p>NO ACTIVE CONTRACTS</p> : null}
    </div>
    {!base.storageLinked ? <p>READ-ONLY DAILY OFFERS</p> : null}
  </>;
}

function FabricatorPanel({ base, notice, chooseRecipe }: {
  base: BasePayload;
  notice: string;
  chooseRecipe: (recipe: Recipe) => void;
}) {
  const stock = new Map(base.stash.map((entry) => [entry.itemType, entry.qty]));
  return <>
    <h2>RECIPES</h2>
    {!base.storageLinked ? <p>READ-ONLY RECIPE CATALOG</p> : null}
    {notice.startsWith("FABRICATED") ? <p className="fabrication-confirmation">{notice}</p> : null}
    <div className="recipe-list">
      {RECIPES.map((recipe) => {
        const owned = recipe.output.kind === "expansion" && base.upgrades.includes(recipe.output.upgradeId);
        const learned = !recipe.requiresBlueprint || base.learnedBlueprints.includes(recipe.requiresBlueprint);
        const objectReady = !recipe.requiresObject || Object.values(base.layout).includes(recipe.requiresObject);
        const missingCosts = recipe.costs
          .map((cost) => ({ ...cost, missing: Math.max(0, cost.qty - (stock.get(cost.itemType) ?? 0)) }))
          .filter((cost) => cost.missing > 0);
        const furnitureKind = recipe.output.kind === "furniture" ? recipe.output.objectKind : null;
        const hasSlot = !furnitureKind || availableBaseSlots(base).some((slot) => !base.layout[slot.id] && isObjectAllowedInSlot(furnitureKind, slot));
        const enabled = base.storageLinked && !owned && learned && objectReady && missingCosts.length === 0 && hasSlot;
        const gate = owned
          ? "OWNED"
          : !base.storageLinked
            ? "OFFLINE — NO STORAGE LINK"
            : !learned
          ? `REQUIRES BLUEPRINT: ${recipe.requiresBlueprint}`
          : !objectReady
            ? `REQUIRES: ${objectName(recipe.requiresObject!)}`
            : !hasSlot
              ? "NO COMPATIBLE EMPTY SLOT"
              : missingCosts.length
                ? `MISSING ${missingCosts.map((cost) => `${cost.missing}× ${wireItemName(cost.itemType)}`).join(" · ")}`
                : recipe.requiresBlueprint
                  ? `BLUEPRINT: ${recipe.requiresBlueprint}`
                  : "FABRICATOR INNATE";
        return <button type="button" key={recipe.id} className="recipe-row" disabled={!enabled} onClick={() => chooseRecipe(recipe)}>
          <span className="recipe-glyph">{recipeGlyph(recipe)}</span>
          <span><strong>{recipeOutputLabel(recipe)}</strong><small>{gate}</small></span>
          <b>{recipe.costs.map((cost) => `${cost.qty}× ${wireItemGlyph(cost.itemType)}`).join(" + ")}</b>
        </button>;
      })}
    </div>
  </>;
}

function FabricationSlotPanel({ panel, base, close, fabricate }: {
  panel: Extract<Exclude<Panel, null>, { type: "fabricateSlot" }>;
  base: BasePayload;
  close: () => void;
  fabricate: (recipeId: string, slotId?: string) => Promise<void>;
}) {
  const recipe = recipeById(panel.recipeId);
  const furnitureKind = recipe?.output.kind === "furniture" ? recipe.output.objectKind : null;
  const choices = furnitureKind
    ? availableBaseSlots(base).filter((slot) => !base.layout[slot.id] && isObjectAllowedInSlot(furnitureKind, slot))
    : [];
  return <section className="base-panel" aria-label="Fabrication placement slot picker">
    <header><span>HOME BAY / FABRICATION</span><strong>PLACE {recipe ? recipeOutputLabel(recipe) : "OBJECT"}</strong><button type="button" onClick={close}>×</button></header>
    <p>SELECT ONE COMPATIBLE EMPTY DECLARED SLOT. FABRICATION IS ATOMIC.</p>
    <div className="slot-choices">
      {choices.map((slot) => <button type="button" key={slot.id} onClick={() => void fabricate(panel.recipeId, slot.id)}>{slot.floor} / {slot.id} / {slot.zone}</button>)}
      {choices.length === 0 ? <span>NO COMPATIBLE EMPTY SLOTS</span> : null}
    </div>
  </section>;
}

function BayConsolePanel({ base, updateLoadout, savePresets, applyPreset, notice }: {
  base: BasePayload;
  updateLoadout: (loadout: WireItemCode[]) => Promise<void>;
  savePresets: (presets: LoadoutPreset[]) => Promise<void>;
  applyPreset: (presetIndex: number) => Promise<void>;
  notice: string;
}) {
  const [presetName, setPresetName] = useState("");
  return <>
    <h2>AT-RISK LOADOUT</h2>
    <div className="loadout-row">{[0, 1, 2, 3].map((index) => {
      const item = base.loadout[index];
      return <button type="button" key={index} disabled={!item || !base.storageLinked} onClick={() => void updateLoadout(base.loadout.filter((_, itemIndex) => itemIndex !== index))} aria-label={item ? `Return ${wireItemName(item)} to stash` : `Empty loadout slot ${index + 1}`}>{item ? wireItemGlyph(item) : "·"}</button>;
    })}</div>
    <p>{base.storageLinked ? "SELECT UP TO FOUR STASHED POWERUPS · TAP A LOADOUT SLOT TO RETURN IT" : "LOADOUT UNAVAILABLE"}</p>
    {base.storageLinked ? <div className="loadout-stash">{base.stash.filter((entry) => !entry.itemType.startsWith("b:")).map((entry) => <button type="button" key={entry.itemType} disabled={base.loadout.length >= 4 || entry.qty < 1} onClick={() => void updateLoadout([...base.loadout, entry.itemType])}><span>{wireItemGlyph(entry.itemType)} {wireItemName(entry.itemType)}</span><b>×{entry.qty}</b></button>)}</div> : null}
    <h2>PRESETS {base.presets.length}/3</h2>
    {notice.startsWith("PRESET") ? <p className="preset-confirmation">{notice}</p> : null}
    <div className="preset-list">
      {base.presets.map((preset, index) => <div className="preset-row" key={`${index}-${preset.name}`}>
        <span><strong>{preset.name}</strong><small>{preset.items.length ? preset.items.map(wireItemGlyph).join(" ") : "EMPTY"}</small></span>
        <button type="button" disabled={!base.storageLinked} onClick={() => void applyPreset(index)}>APPLY</button>
        <button type="button" disabled={!base.storageLinked} onClick={() => void savePresets(base.presets.filter((_, candidate) => candidate !== index))}>DELETE</button>
      </div>)}
    </div>
    {base.storageLinked && base.presets.length < 3 ? <div className="preset-save">
      <input aria-label="Preset name" maxLength={24} placeholder="PRESET NAME" value={presetName} onChange={(event) => setPresetName(event.target.value)} />
      <button type="button" disabled={!presetName.trim() || base.loadout.length === 0} onClick={() => {
        const clean = presetName.trim().replace(/\s+/g, " ").slice(0, 24);
        if (!clean) return;
        void savePresets([...base.presets, { name: clean, items: base.loadout.filter(isWireLoadout) }]);
        setPresetName("");
      }}>SAVE CURRENT</button>
    </div> : null}
  </>;
}

function ObjectPanel({ panel, close, chooseMove }: {
  panel: Extract<Exclude<Panel, null>, { type: "object" }>;
  close: () => void;
  chooseMove: (panel: Exclude<Panel, null>) => void;
}) {
  return <section className="base-panel" aria-label={`${objectName(panel.kind)} panel`}>
    <header><span>HOME BAY / OBJECT</span><strong>{objectName(panel.kind)}</strong><button type="button" onClick={close}>×</button></header>
    <p>{panel.kind === "repairBench" ? "REPAIR BENCH ONLINE · HEALTH CONVERSION ENABLED" : "DISPLAYED FROM A LEARNED CITY BLUEPRINT · NO COMBAT STAT MODIFIERS"}</p>
    <footer><button type="button" onClick={() => chooseMove({ type: "move", fromSlotId: panel.slotId })}>MOVE</button></footer>
  </section>;
}

function MovePanel({ panel, base, close, move }: {
  panel: Extract<Exclude<Panel, null>, { type: "move" }>;
  base: BasePayload;
  close: () => void;
  move: (from: string, to: string) => void;
}) {
  const layout = base.layout;
  const slots = availableBaseSlots(base);
  const slotIndex = new Map<string, { id: string; zone: "wall" | "floor"; floor: "GROUND" | "F1" }>(slots.map((slot) => [slot.id, slot]));
  const choices = panel.fromSlotId
    ? slots.filter((slot) => !layout[slot.id] && isObjectAllowedInSlot(layout[panel.fromSlotId!]!, slot)).map((slot) => ({ slotId: slot.id, label: `${slot.floor} / ${slot.id}` }))
    : Object.entries(layout).filter(([from, kind]) => panel.toSlotId && slotIndex.has(from) && isObjectAllowedInSlot(kind, slotIndex.get(panel.toSlotId)!)).map(([slotId, kind]) => ({ slotId, label: `${kind} / ${slotIndex.get(slotId)!.floor} / ${slotId}` }));
  return (
    <section className="base-panel" aria-label="Placement slot picker">
      <header><span>HOME BAY / PLACEMENT</span><strong>SELECT SLOT</strong><button type="button" onClick={close}>×</button></header>
      <p>OBJECTS SNAP TO DECLARED WALL OR FLOOR SLOTS.</p>
      <div className="slot-choices">
        {choices.map((choice) => <button type="button" key={choice.slotId} onClick={() => {
          if (panel.fromSlotId) move(panel.fromSlotId, choice.slotId);
          else if (panel.toSlotId) move(choice.slotId, panel.toSlotId);
        }}>{choice.label}</button>)}
        {choices.length === 0 ? <span>NO COMPATIBLE EMPTY SLOTS</span> : null}
      </div>
    </section>
  );
}

function ShellPanel({ current, expanded, storageLinked, close, updateShell, move }: {
  current: BaseShellId;
  expanded: boolean;
  storageLinked: boolean;
  close: () => void;
  updateShell: (shell: BaseShellId) => Promise<void>;
  move: () => void;
}) {
  return (
    <section className="base-panel shell-panel" aria-label="Base layout picker">
      <header><span>HOME BAY / DRAFTING TABLE</span><strong>BASE LAYOUT</strong><button type="button" onClick={close}>×</button></header>
      <p>SAME SLOTS AND CAPACITY IN EVERY LAYOUT. CHOOSE THE SPACE THAT FEELS LIKE HOME.</p>
      <div className="shell-choices">
        {BASE_SHELL_IDS.map((shellId) => {
          const def = baseShellDef(shellId);
          return (
            <button
              type="button"
              key={shellId}
              className={shellId === current ? "shell-choice is-current" : "shell-choice"}
              aria-pressed={shellId === current}
              onClick={() => void updateShell(shellId)}
            >
              <ShellPreview shell={shellId} expanded={expanded} />
              <strong>{def.name}</strong>
              <small>{def.blurb}</small>
            </button>
          );
        })}
      </div>
      {!storageLinked ? <p className="offline-hint">STORAGE LINK REQUIRED TO CHANGE THE BASE LAYOUT</p> : null}
      <footer><button type="button" onClick={move}>MOVE DRAFTING TABLE</button></footer>
    </section>
  );
}

/** Miniature plan-view of a shell, drawn from the same wall data as the map. */
function ShellPreview({ shell, expanded }: { shell: BaseShellId; expanded: boolean }) {
  const def = baseShellDef(shell);
  return (
    <svg viewBox="0 0 1000 760" role="img" aria-label={`${def.name} floor plan`}>
      {def.walls.map((wall) => (
        <rect key={wall.id} x={wall.x} y={wall.y} width={wall.w} height={wall.h} fill="currentColor" />
      ))}
      <rect
        x={def.deployment.x}
        y={def.deployment.y}
        width={def.deployment.w}
        height={def.deployment.h}
        fill="none"
        stroke="currentColor"
        strokeWidth={6}
        strokeDasharray="18 12"
      />
      {def.slots.map((slot) => (
        <rect
          key={slot.id}
          x={slot.rect.x}
          y={slot.rect.y}
          width={slot.rect.w}
          height={slot.rect.h}
          fill="none"
          stroke="currentColor"
          strokeWidth={4}
          opacity={0.55}
        />
      ))}
      {expanded ? <text x="500" y="730" textAnchor="middle" fontSize="52" fontWeight="800" fill="currentColor">+ FLOOR 1</text> : null}
    </svg>
  );
}

function ItemCounts({ items }: { items: BasePayload["stash"] }) {
  return items.length ? <ul className="base-stash">{items.map((entry) => <li key={entry.itemType}><span>{wireItemGlyph(entry.itemType)} {wireItemName(entry.itemType)}</span><b>×{entry.qty}</b></li>)}</ul> : <p>EMPTY</p>;
}

function stashCount(items: BasePayload["stash"]): number {
  return items.reduce((total, entry) => total + entry.qty, 0);
}

function recipeGlyph(recipe: Recipe): string {
  if (recipe.output.kind === "furniture") return recipe.output.objectKind === "repairBench" ? "✚" : "▱";
  if (recipe.output.kind === "expansion") return "▤";
  return wireItemGlyph(itemToCode(recipe.output.item));
}

function recipeOutputLabel(recipe: Recipe): string {
  if (recipe.output.kind === "furniture") return objectName(recipe.output.objectKind);
  if (recipe.output.kind === "expansion") return "SECOND FLOOR";
  return wireItemName(itemToCode(recipe.output.item));
}

function ownsSecondFloor(base: Pick<BasePayload, "upgrades">): boolean {
  return base.upgrades.includes(SECOND_FLOOR_UPGRADE_ID);
}

function availableBaseSlots(base: Pick<BasePayload, "upgrades">) {
  const expanded = ownsSecondFloor(base);
  return BASE_SLOT_DEFS.filter((slot) => slot.floor === "GROUND" || expanded);
}

function objectName(kind: BaseObjectKind): string {
  return kind.replace(/([A-Z])/g, " $1").toUpperCase();
}

function isWireLoadout(code: WireItemCode): code is WireLoadoutCode {
  return code === "h" || code === "r" || code === "d" || code === "i" || code === "m";
}

function moveObject(layout: BaseLayout, from: string, to: string): BaseLayout {
  const kind = layout[from];
  if (!kind || layout[to]) return layout;
  const next = { ...layout, [to]: kind };
  delete next[from];
  return next;
}

function readLocalLayout(): BaseLayout {
  try {
    const value = JSON.parse(localStorage.getItem(localLayoutKey) ?? "null") as BaseLayout | null;
    if (!value || typeof value !== "object") return { ...starterBaseLayout };
    validateBaseLayout(value);
    return value;
  } catch {
    return { ...starterBaseLayout };
  }
}

function readLocalShell(): BaseShellId {
  const value = localStorage.getItem(localShellKey);
  return isBaseShellId(value) ? value : DEFAULT_BASE_SHELL;
}

function tutorialStepLabel(phase: BaseTutorialState["phase"]): string {
  return phase === "movement"
    ? "FIRST STEP"
    : phase === "practice"
      ? "SAFE PRACTICE"
      : phase === "fabricator"
        ? "FABRICATION"
        : "ITEM READY";
}

function tutorialInstruction(phase: BaseTutorialState["phase"]): string {
  return phase === "movement"
    ? "MOVE YOUR DOTBOT"
    : phase === "practice"
      ? "DASH INTO THE PRACTICE BOT"
      : phase === "fabricator"
        ? "USE THE FABRICATOR"
        : "ENTER YOUR BASE";
}

function tutorialTargetForPhase(
  target: BaseTarget | null,
  phase: BaseTutorialState["phase"],
): BaseTarget | null {
  if (!target) return null;
  if (phase === "fabricator") return target.type === "tutorialFabricator" ? target : null;
  if (phase === "complete") return target.type === "tutorialFabricator" ? null : target;
  return null;
}

function wireItemGlyph(code: WireItemCode): string {
  return code === "h" ? "+" : code === "r" ? "◎" : code === "d" ? "›" : code === "i" ? "◌" : code === "m" ? "×" : "⌑";
}
function wireItemName(code: WireItemCode): string {
  if (code.startsWith("b:")) return `${code.slice(2)} fragment`;
  return code === "h" ? "Health" : code === "r" ? "Radar" : code === "d" ? "Dash overcharge" : code === "i" ? "Incognito" : "Mine";
}
