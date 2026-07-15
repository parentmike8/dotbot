import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { defaultGameConfig } from "@dotbot/game/config";
import {
  basePlacementSlots,
  createBaseMap,
  isObjectAllowedInSlot,
  starterBaseLayout,
  validateBaseLayout,
} from "@dotbot/game/content/base";
import type { BaseLayout, BaseObjectKind, MapObject, PlacementSlot, Rect, Vec2 } from "@dotbot/game/types";
import type { WireItemCode } from "@dotbot/protocol";
import { useDotBotGame } from "../../game/useDotBotGame";
import { createSession } from "../../game/session/createSession";
import { LobbyApp } from "../lobby/LobbyApp";
import { deviceTokenKey, ensureAccountToken, playerNameKey } from "../identity";
import "./base.css";

const localLayoutKey = "dotbot.baseLayout";
const channelDurationMs = 1000;
const interactionReach = 46;

export type BasePayload = {
  storageLinked: boolean;
  layout: BaseLayout;
  stash: Array<{ itemType: WireItemCode; qty: number }>;
  learnedBlueprints: string[];
  loadout: WireItemCode[];
};

type BaseTarget =
  | { id: string; type: "deployment"; center: Vec2; rect: Rect }
  | { id: string; type: "object"; center: Vec2; rect: Rect; object: MapObject }
  | { id: string; type: "emptySlot"; center: Vec2; rect: Rect; slot: PlacementSlot };

type Panel =
  | { type: "locker" | "bayConsole" | "fabricator" | "planningTable"; slotId: string }
  | { type: "move"; fromSlotId?: string; toSlotId?: string }
  | null;

const offlinePayload: BasePayload = {
  storageLinked: false,
  layout: starterBaseLayout,
  stash: [],
  learnedBlueprints: [],
  loadout: [],
};

export function BaseApp() {
  const [name, setName] = useState(() => localStorage.getItem(playerNameKey) ?? "");
  const [identityReady, setIdentityReady] = useState(() => Boolean(localStorage.getItem(playerNameKey)));
  const [base, setBase] = useState<BasePayload>(() => ({ ...offlinePayload, layout: readLocalLayout() }));
  const [panel, setPanel] = useState<Panel>(null);
  const [deployment, setDeployment] = useState(() => /^#\/r\/[A-Z2-9]{4}$/i.test(window.location.hash) || window.location.hash === "#/lobby");
  const [notice, setNotice] = useState("");

  const refreshBase = useCallback(async () => {
    const token = localStorage.getItem(deviceTokenKey);
    if (!token) return;
    try {
      const response = await fetch("/api/base", { headers: { "x-device-token": token } });
      if (!response.ok) throw new Error(`Base fetch failed (${response.status})`);
      const payload = await response.json() as BasePayload;
      const next = { ...payload, layout: { ...payload.layout } };
      setBase(next);
      localStorage.setItem(localLayoutKey, JSON.stringify(next.layout));
      setNotice("");
    } catch {
      setBase((current) => ({ ...current, storageLinked: false, layout: readLocalLayout() }));
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

  const updateLayout = useCallback(async (nextLayout: BaseLayout) => {
    localStorage.setItem(localLayoutKey, JSON.stringify(nextLayout));
    setBase((current) => ({ ...current, layout: nextLayout }));
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
      setBase((current) => ({ ...current, layout: payload.layout }));
      localStorage.setItem(localLayoutKey, JSON.stringify(payload.layout));
    } catch {
      setBase((current) => ({ ...current, storageLinked: false }));
      setNotice("LAYOUT SAVED TO THIS DEVICE");
    }
  }, []);

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
  updateLayout: (layout: BaseLayout) => Promise<void>;
};

function BaseSession(props: BaseSessionProps) {
  const map = useMemo(() => createBaseMap(props.base.layout), [props.base.layout]);
  const session = useMemo(() => createSession("local", {
    map,
    config: { ...defaultGameConfig, runDurationMs: Number.MAX_SAFE_INTEGER },
    playerId: "player",
  }), [map]);
  const { hostRef, snapshot, playerId, setInteractionChannel } = useDotBotGame({ session });
  const player = snapshot?.bots.find((bot) => bot.id === playerId);
  const channelRef = useRef<{ targetId: string; startedAt: number; lastPosition: Vec2; completedId: string | null } | null>(null);

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
    const previous = channelRef.current;
    const moved = previous ? distance(previous.lastPosition, player.position) > 1.5 : true;

    if (!target) {
      channelRef.current = { targetId: "", startedAt: snapshot.timeMs, lastPosition: { ...player.position }, completedId: null };
      setInteractionChannel(null);
      return;
    }
    if (previous?.completedId === target.id && !moved) {
      setInteractionChannel(null);
      return;
    }
    const startedAt = !previous || previous.targetId !== target.id || moved ? snapshot.timeMs : previous.startedAt;
    const progress = Math.min(1, Math.max(0, (snapshot.timeMs - startedAt) / channelDurationMs));
    channelRef.current = {
      targetId: target.id,
      startedAt,
      lastPosition: { ...player.position },
      completedId: progress >= 1 ? target.id : moved ? null : previous?.completedId ?? null,
    };
    setInteractionChannel({ position: target.center, radius: Math.max(target.rect.w, target.rect.h) / 2 + 10, progress });
    if (progress >= 1 && previous?.completedId !== target.id) openTarget(target);
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
    <main className="base-shell" aria-label="DotBot persistent base" data-storage-linked={props.base.storageLinked}>
      <div ref={hostRef} className="game-canvas" />
      <header className="base-title-block">
        <span>DOTBOT / HOME BAY</span>
        <strong>{props.name || "UNCOMMISSIONED"}</strong>
        <small>{props.base.storageLinked ? "STORAGE LINK ACTIVE" : "OFFLINE — NO STORAGE LINK"}</small>
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
          move={(fromSlotId, toSlotId) => props.updateLayout(moveObject(props.base.layout, fromSlotId, toSlotId))}
          chooseMove={(next) => props.setPanel(next)}
        />
      ) : null}
    </main>
  );
}

function BasePanel({ panel, base, close, move, chooseMove }: {
  panel: Exclude<Panel, null>;
  base: BasePayload;
  close: () => void;
  move: (fromSlotId: string, toSlotId: string) => void;
  chooseMove: (panel: Exclude<Panel, null>) => void;
}) {
  if (panel.type === "move") {
    return <MovePanel panel={panel} layout={base.layout} close={close} move={move} />;
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
        <div className="loadout-row">{[0, 1, 2, 3].map((index) => <span key={index}>{base.loadout[index] ? wireItemGlyph(base.loadout[index]) : "·"}</span>)}</div>
        <p>{base.storageLinked ? "SELECT UP TO FOUR STASHED POWERUPS" : "LOADOUT UNAVAILABLE"}</p>
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
  const slotIndex = new Map(basePlacementSlots.map((slot) => [slot.id, slot]));
  const choices = panel.fromSlotId
    ? basePlacementSlots.filter((slot) => !layout[slot.id] && isObjectAllowedInSlot(layout[panel.fromSlotId!]!, slot)).map((slot) => ({ slotId: slot.id, label: slot.id }))
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

function ItemCounts({ items }: { items: BasePayload["stash"] }) {
  return items.length ? <ul className="base-stash">{items.map((entry) => <li key={entry.itemType}><span>{wireItemGlyph(entry.itemType)} {wireItemName(entry.itemType)}</span><b>×{entry.qty}</b></li>)}</ul> : <p>EMPTY</p>;
}

function findBaseTarget(map: ReturnType<typeof createBaseMap>, position: Vec2): BaseTarget | null {
  const deployment = map.extractionPoints[0];
  if (contains(deployment.rect, position)) return { id: deployment.id, type: "deployment", center: center(deployment.rect), rect: deployment.rect };
  const floor = map.buildings[0]?.floors[0];
  const object = floor?.objects.find((candidate) => distanceToRect(position, candidate) <= interactionReach);
  if (object) return { id: object.id, type: "object", center: center(object), object, rect: object };
  const occupied = new Set(floor?.objects.map((candidate) => candidate.slotId));
  const slot = map.placementSlots?.find((candidate) => !occupied.has(candidate.id) && distanceToRect(position, candidate.rect) <= interactionReach);
  return slot ? { id: `empty-${slot.id}`, type: "emptySlot", center: center(slot.rect), slot, rect: slot.rect } : null;
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

function contains(rect: Rect, point: Vec2): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h;
}
function center(rect: Rect): Vec2 { return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }; }
function distance(a: Vec2, b: Vec2): number { return Math.hypot(a.x - b.x, a.y - b.y); }
function distanceToRect(point: Vec2, rect: Rect): number {
  const dx = point.x - Math.max(rect.x, Math.min(point.x, rect.x + rect.w));
  const dy = point.y - Math.max(rect.y, Math.min(point.y, rect.y + rect.h));
  return Math.hypot(dx, dy);
}

function wireItemGlyph(code: WireItemCode): string {
  return code === "h" ? "+" : code === "r" ? "◎" : code === "d" ? "›" : code === "i" ? "◌" : "⌑";
}
function wireItemName(code: WireItemCode): string {
  if (code.startsWith("b:")) return `${code.slice(2)} fragment`;
  return code === "h" ? "Health" : code === "r" ? "Radar" : code === "d" ? "Dash overcharge" : "Incognito";
}
