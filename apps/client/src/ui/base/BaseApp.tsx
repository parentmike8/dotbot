import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { defaultGameConfig } from "@dotbot/game/config";
import {
  BASE_SHELL_IDS,
  BASE_SLOT_DEFS,
  DEFAULT_BASE_SHELL,
  baseShellDef,
  createBaseMap,
  isBaseShellId,
  isObjectAllowedInSlot,
  starterBaseLayout,
  validateBaseLayout,
} from "@dotbot/game/content/base";
import type { BaseLayout, BaseShellId } from "@dotbot/game/types";
import type { WireItemCode } from "@dotbot/protocol";
import { useDotBotGame } from "../../game/useDotBotGame";
import { createSession } from "../../game/session/createSession";
import { LobbyApp } from "../lobby/LobbyApp";
import { deviceTokenKey, ensureAccountToken, playerNameKey } from "../identity";
import "./base.css";
import { advanceBaseChannel, findBaseTarget, type BaseChannelState, type BaseTarget } from "./baseFlow";

const localLayoutKey = "dotbot.baseLayout";
const localShellKey = "dotbot.baseShell";
const seedDraftedKey = "dotbot.baseSeedDrafted";
const channelDurationMs = 1000;

export type BasePayload = {
  storageLinked: boolean;
  shell: BaseShellId;
  layout: BaseLayout;
  stash: Array<{ itemType: WireItemCode; qty: number }>;
  learnedBlueprints: string[];
  loadout: WireItemCode[];
};

type Panel =
  | { type: "locker" | "bayConsole" | "fabricator" | "planningTable"; slotId: string }
  | { type: "move"; fromSlotId?: string; toSlotId?: string }
  | { type: "settings" }
  | null;

const offlinePayload: BasePayload = {
  storageLinked: false,
  shell: DEFAULT_BASE_SHELL,
  layout: starterBaseLayout,
  stash: [],
  learnedBlueprints: [],
  loadout: [],
};

export function BaseApp() {
  const [name, setName] = useState(() => localStorage.getItem(playerNameKey) ?? "");
  const [identityReady, setIdentityReady] = useState(() => Boolean(localStorage.getItem(playerNameKey)));
  const [base, setBase] = useState<BasePayload>(() => ({ ...offlinePayload, layout: readLocalLayout(), shell: readLocalShell() }));
  const [panel, setPanel] = useState<Panel>(null);
  const [deployment, setDeployment] = useState(() => /^#\/r\/[A-Z2-9]{4}$/i.test(window.location.hash) || window.location.hash === "#/lobby");
  const [notice, setNotice] = useState("");
  const [draftObjectIds, setDraftObjectIds] = useState<string[]>(() => localStorage.getItem(seedDraftedKey)
    ? []
    : Object.keys(readLocalLayout()).map((slotId) => `base-object-${slotId}`));

  const refreshBase = useCallback(async () => {
    const token = localStorage.getItem(deviceTokenKey);
    if (!token) return;
    try {
      const response = await fetch("/api/base", { headers: { "x-device-token": token } });
      if (!response.ok) throw new Error(`Base fetch failed (${response.status})`);
      const payload = await response.json() as BasePayload;
      const next = {
        ...payload,
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
      setBase((current) => ({ ...current, storageLinked: false, layout: readLocalLayout(), shell: readLocalShell() }));
    }
  }, []);

  useEffect(() => {
    if (!identityReady) return;
    const storedName = localStorage.getItem(playerNameKey) ?? name;
    void ensureAccountToken(storedName).then(refreshBase);
  }, [identityReady, name, refreshBase]);

  const finishIdentity = async (event: FormEvent) => {
    event.preventDefault();
    const clean = name.trim().replace(/\s+/g, " ").slice(0, 24);
    if (!clean) return;
    localStorage.setItem(playerNameKey, clean);
    setName(clean);
    await ensureAccountToken(clean);
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
    localStorage.setItem(localShellKey, shell);
    if (shell !== base.shell) {
      // Moving shells re-drafts the whole base: every placed object queues
      // through the same draw-on used for fabrication.
      setDraftObjectIds(Object.keys(base.layout).map((slotId) => `base-object-${slotId}`));
      setBase((current) => ({ ...current, shell }));
      setPanel(null);
    }
    const token = localStorage.getItem(deviceTokenKey);
    if (!token) return;
    try {
      const response = await fetch("/api/base/shell", {
        method: "POST",
        headers: { "content-type": "application/json", "x-device-token": token },
        body: JSON.stringify({ shell }),
      });
      if (!response.ok) throw new Error(`Shell update failed (${response.status})`);
      setNotice("");
    } catch {
      setBase((current) => ({ ...current, storageLinked: false }));
      setNotice("SHELL SAVED TO THIS DEVICE");
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

  if (deployment) {
    return <LobbyApp embedded onReturnToBase={() => {
      setDeployment(false);
      setPanel(null);
      window.history.replaceState(null, "", "/");
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
        window.history.replaceState(null, "", "/#/lobby");
      }}
      updateLayout={updateLayout}
      updateShell={updateShell}
      draftObjectIds={draftObjectIds}
      onDraftQueued={() => {
        localStorage.setItem(seedDraftedKey, "1");
        setDraftObjectIds([]);
      }}
      updateLoadout={updateLoadout}
    />
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
};

function BaseSession(props: BaseSessionProps) {
  const map = useMemo(() => createBaseMap(props.base.layout, props.base.shell), [props.base.layout, props.base.shell]);
  const session = useMemo(() => createSession("local", {
    map,
    config: { ...defaultGameConfig, runDurationMs: Number.MAX_SAFE_INTEGER },
    playerId: "player",
  }), [map]);
  const { hostRef, snapshot, playerId, setInteractionChannel, draftObjects } = useDotBotGame({ session });
  const player = snapshot?.bots.find((bot) => bot.id === playerId);
  const channelRef = useRef<BaseChannelState | null>(null);

  useEffect(() => {
    if (props.draftObjectIds.length === 0) return;
    draftObjects(props.draftObjectIds);
    props.onDraftQueued();
  }, [draftObjects, props]);

  const openTarget = useCallback((target: BaseTarget) => {
    if (target.type === "deployment") {
      props.openDeployment();
      return;
    }
    if (target.type === "emptySlot") {
      props.setPanel({ type: "move", toSlotId: target.slot.id });
      return;
    }
    const kind = target.object.kind;
    if (kind === "locker" || kind === "bayConsole" || kind === "fabricator" || kind === "planningTable") {
      props.setPanel({ type: kind, slotId: target.object.slotId! });
    }
  }, [props]);

  useEffect(() => {
    if (!snapshot || !player || !props.identityReady || props.panel) {
      setInteractionChannel(null);
      return;
    }
    const target = findBaseTarget(map, player.position);
    const advanced = advanceBaseChannel(channelRef.current, target, player.position, snapshot.timeMs, channelDurationMs);
    channelRef.current = advanced.state;
    setInteractionChannel(target && advanced.progress !== null
      ? { position: target.center, radius: Math.max(target.rect.w, target.rect.h) / 2 + 10, progress: advanced.progress }
      : null);
    if (advanced.completed) openTarget(advanced.completed);
  }, [map, openTarget, player, props.identityReady, props.panel, setInteractionChannel, snapshot]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __dotbotBase?: unknown }).__dotbotBase = {
      storageLinked: props.base.storageLinked,
      layout: props.base.layout,
      panel: props.panel?.type ?? null,
      playerPosition: player?.position ?? null,
    };
  }, [player, props.base, props.panel]);

  return (
    <main
      className="base-shell"
      aria-label="DotBot persistent base"
      data-storage-linked={props.base.storageLinked}
      data-player-x={player ? Math.round(player.position.x) : undefined}
      data-player-y={player ? Math.round(player.position.y) : undefined}
      data-panel={props.panel?.type ?? "none"}
    >
      <div ref={hostRef} className="game-canvas" />
      <header className="base-title-block">
        <span>DOTBOT / HOME BAY</span>
        <strong>{props.name || "UNCOMMISSIONED"}</strong>
        <small>{props.base.storageLinked ? "STORAGE LINK ACTIVE" : "OFFLINE — NO STORAGE LINK"}</small>
        <button
          type="button"
          className="base-settings-button"
          disabled={!props.identityReady}
          onClick={() => props.setPanel(props.panel?.type === "settings" ? null : { type: "settings" })}
        >
          SHELL PLAN: {baseShellDef(props.base.shell).name} ▾
        </button>
      </header>
      <div className="base-instruction">STAND STILL AT AN OBJECT TO CHANNEL · WALK THROUGH DEPLOYMENT TO LEAVE</div>
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
        />
      ) : null}
    </main>
  );
}

function BasePanel({ panel, base, close, move, chooseMove, updateLoadout, updateShell }: {
  panel: Exclude<Panel, null>;
  base: BasePayload;
  close: () => void;
  move: (fromSlotId: string, toSlotId: string) => void;
  chooseMove: (panel: Exclude<Panel, null>) => void;
  updateLoadout: (loadout: WireItemCode[]) => Promise<void>;
  updateShell: (shell: BaseShellId) => Promise<void>;
}) {
  if (panel.type === "move") {
    return <MovePanel panel={panel} layout={base.layout} close={close} move={move} />;
  }
  if (panel.type === "settings") {
    return <ShellPanel current={base.shell} storageLinked={base.storageLinked} close={close} updateShell={updateShell} />;
  }
  const title = panel.type === "bayConsole" ? "BAY CONSOLE" : panel.type.replace(/([A-Z])/g, " $1").toUpperCase();
  return (
    <section className="base-panel" aria-label={`${title} panel`}>
      <header><span>HOME BAY / OBJECT</span><strong>{title}</strong><button type="button" onClick={close}>×</button></header>
      {!base.storageLinked && (panel.type === "locker" || panel.type === "bayConsole") ? <p className="offline-hint">OFFLINE — NO STORAGE LINK</p> : null}
      {panel.type === "locker" ? <>
        <h2>STASH</h2><ItemCounts items={base.stash} />
        <h2>LEARNED BLUEPRINTS</h2><p>{base.learnedBlueprints.length ? base.learnedBlueprints.join(" · ") : "NONE YET"}</p>
      </> : null}
      {panel.type === "bayConsole" ? <>
        <h2>AT-RISK LOADOUT</h2>
        <div className="loadout-row">{[0, 1, 2, 3].map((index) => {
          const item = base.loadout[index];
          return <button type="button" key={index} disabled={!item || !base.storageLinked} onClick={() => void updateLoadout(base.loadout.filter((_, itemIndex) => itemIndex !== index))} aria-label={item ? `Return ${wireItemName(item)} to stash` : `Empty loadout slot ${index + 1}`}>{item ? wireItemGlyph(item) : "·"}</button>;
        })}</div>
        <p>{base.storageLinked ? "SELECT UP TO FOUR STASHED POWERUPS · TAP A LOADOUT SLOT TO RETURN IT" : "LOADOUT UNAVAILABLE"}</p>
        {base.storageLinked ? <div className="loadout-stash">{base.stash.filter((entry) => !entry.itemType.startsWith("b:")).map((entry) => <button type="button" key={entry.itemType} disabled={base.loadout.length >= 4 || entry.qty < 1} onClick={() => void updateLoadout([...base.loadout, entry.itemType])}><span>{wireItemGlyph(entry.itemType)} {wireItemName(entry.itemType)}</span><b>×{entry.qty}</b></button>)}</div> : null}
      </> : null}
      {panel.type === "fabricator" ? <>
        <h2>LEARNED BLUEPRINTS</h2><p>{base.learnedBlueprints.length ? base.learnedBlueprints.join(" · ") : "NONE YET"}</p>
        <p>FABRICATION COMES ONLINE WITH THE NEXT BASE UPGRADE PASS.</p>
      </> : null}
      {panel.type === "planningTable" ? <p className="stub-message">CONTRACTS — NOT YET COMMISSIONED</p> : null}
      <footer><button type="button" onClick={() => chooseMove({ type: "move", fromSlotId: panel.slotId })}>MOVE</button></footer>
    </section>
  );
}

function MovePanel({ panel, layout, close, move }: {
  panel: Extract<Exclude<Panel, null>, { type: "move" }>;
  layout: BaseLayout;
  close: () => void;
  move: (from: string, to: string) => void;
}) {
  const slotIndex = new Map<string, { id: string; zone: "wall" | "floor" }>(BASE_SLOT_DEFS.map((slot) => [slot.id, slot]));
  const choices = panel.fromSlotId
    ? BASE_SLOT_DEFS.filter((slot) => !layout[slot.id] && isObjectAllowedInSlot(layout[panel.fromSlotId!]!, slot)).map((slot) => ({ slotId: slot.id, label: slot.id }))
    : Object.entries(layout).filter(([from, kind]) => panel.toSlotId && isObjectAllowedInSlot(kind, slotIndex.get(panel.toSlotId)!)).map(([slotId, kind]) => ({ slotId, label: `${kind} / ${slotId}` }));
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

function ShellPanel({ current, storageLinked, close, updateShell }: {
  current: BaseShellId;
  storageLinked: boolean;
  close: () => void;
  updateShell: (shell: BaseShellId) => Promise<void>;
}) {
  return (
    <section className="base-panel shell-panel" aria-label="Shell plan picker">
      <header><span>HOME BAY / SETTINGS</span><strong>SHELL PLAN</strong><button type="button" onClick={close}>×</button></header>
      <p>SAME SLOTS, SAME CAPACITY, EVERY PLAN — LAYOUT AND AESTHETICS ONLY.</p>
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
              <ShellPreview shell={shellId} />
              <strong>{def.name}</strong>
              <small>{def.blurb}</small>
            </button>
          );
        })}
      </div>
      {!storageLinked ? <p className="offline-hint">OFFLINE — CHOICE SAVED TO THIS DEVICE</p> : null}
    </section>
  );
}

/** Miniature plan-view of a shell, drawn from the same wall data as the map. */
function ShellPreview({ shell }: { shell: BaseShellId }) {
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
    </svg>
  );
}

function ItemCounts({ items }: { items: BasePayload["stash"] }) {
  return items.length ? <ul className="base-stash">{items.map((entry) => <li key={entry.itemType}><span>{wireItemGlyph(entry.itemType)} {wireItemName(entry.itemType)}</span><b>×{entry.qty}</b></li>)}</ul> : <p>EMPTY</p>;
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

function wireItemGlyph(code: WireItemCode): string {
  return code === "h" ? "+" : code === "r" ? "◎" : code === "d" ? "›" : code === "i" ? "◌" : "⌑";
}
function wireItemName(code: WireItemCode): string {
  if (code.startsWith("b:")) return `${code.slice(2)} fragment`;
  return code === "h" ? "Health" : code === "r" ? "Radar" : code === "d" ? "Dash overcharge" : "Incognito";
}
