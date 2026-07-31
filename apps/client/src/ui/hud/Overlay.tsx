import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DotBotEntity, GameConfig, GameSnapshot, Item, PingKind } from "@dotbot/game/types";
import { PING_KINDS } from "@dotbot/game/types";
import { arrivalSparkline, type NetworkDebugStats } from "../../game/session/netgraph";
import type { ArrivalGroup } from "../../mapSelection";
import { itemFamily, itemGlyph, itemLabel } from "../items";
import { bayStrip, formatRunClock, type FloorColumn } from "./hud";
import { PING_LABEL } from "../../game/pings";

/**
 * The overlay, once — used by both the solo sandbox and a real match.
 *
 * ONE RULE, and it is the whole design: anything that describes a thing in the world
 * gets drawn at that thing, not in a corner. The bot's plates are on the bot. A
 * capture ring is on the Dot. A loot prompt is on the body. What is left up here is
 * only what the world has no way to say — how long the run has, how many enemies are
 * still standing, what is in your bays, and which floor of the stack you are on.
 *
 * That rule retired five surfaces. The status line ("Explore", "Capturing") narrated
 * what you could already see. The shield row repeated the plates drawn on your own
 * bot. The coverage meter duplicated a progress ring that already exists at every
 * thing that can be covered — the Dot, the body, the extraction pad. The location
 * label repeated the floor rail. And the item key is gone because every Dot carries
 * its own mark, so a table mapping marks to names was teaching what the world shows.
 *
 * Two things stay that the rule alone would have cut. The restart button, because it
 * is how a run gets tested. And the floor rail, because the alternative is writing the
 * floor number on the floor, and a building that labels its own storeys from the
 * inside reads as a diagram rather than a place.
 */

/**
 * Top-left: the run's own clock and headcount, with whatever the surface adds.
 *
 * `onSettings` is here rather than in each surface because there is no L key on a
 * phone, and this game ships thumb controls — without a button the sound and
 * reduced-motion switches are simply unreachable on the device most likely to need
 * them.
 */
export function RunReadout({
  remainingRunMs,
  rivals,
  onSettings,
  children,
}: {
  remainingRunMs: number;
  rivals: number;
  onSettings?: () => void;
  children?: ReactNode;
}) {
  return (
    <section className="hud hud-top-left" aria-label="Run status">
      <dl className="run-readout">
        <div>
          <dt>Time</dt>
          <dd>
            <time dateTime={`PT${Math.max(0, Math.floor(remainingRunMs / 1000))}S`}>
              {formatRunClock(remainingRunMs)}
            </time>
          </dd>
        </div>
        <div>
          <dt>Rivals</dt>
          <dd aria-label={`${rivals} rivals still standing`}>{rivals}</dd>
        </div>
      </dl>
      <div className="hud-actions">
        {children}
        {onSettings ? (
          <button type="button" className="settings-button" onClick={onSettings}>Settings</button>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Top-right: the three bays, and how much is riding in the hold.
 *
 * `slots` is passed rather than read from a default, because a match's config arrives
 * with the session. The net surface used to draw four from a literal while the game
 * has three, so one of the slots it showed could never hold anything.
 */
export function BayBank({
  player,
  slots,
  holdSlots,
  onUse,
  onOpen,
  open,
  disabled = false,
}: {
  player: DotBotEntity | undefined;
  slots: number;
  holdSlots: number;
  onUse: (index: number) => void;
  onOpen: () => void;
  open: boolean;
  disabled?: boolean;
}) {
  const canAct = player?.state === "alive";
  const openButton = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open) openButton.current?.focus();
    wasOpen.current = open;
  }, [open]);
  return (
    <section className="hud hud-top-right" aria-label="Bays">
      <div className="bay-bank">
        <div className="bay-bank-row">
          <div className="bay-strip">
            {bayStrip(player?.bays, slots).map((item, index) => (
              <button
                type="button"
                className={`bay-button ${itemFamily(item)}`}
                key={index}
                onPointerDown={(event) => {
                  // Mobile Safari can suppress the later synthetic click while
                  // another finger is holding the movement joystick. Use this
                  // pointer independently so moving never blocks an item use.
                  if (event.pointerType !== "mouse") event.preventDefault();
                  onUse(index);
                }}
                onClick={(event) => {
                  // Pointer presses are handled above. A keyboard-activated
                  // native button click has detail 0 and still needs to work.
                  if (event.detail === 0) onUse(index);
                }}
                disabled={!item || !canAct}
                aria-label={`Bay ${index + 1}${item ? `: ${itemLabel(item)}` : ": empty"}`}
              >
                <small>{index + 1}</small><strong>{itemGlyph(item)}</strong>
              </button>
            ))}
          </div>
          <div className="inventory-access">
            <button
              ref={openButton}
              type="button"
              className="inventory-open"
              onClick={onOpen}
              disabled={disabled}
              aria-expanded={open}
              aria-controls="inventory-panel"
            >Open</button>
            <div className="hold-chip" aria-label={`${player?.hold.length ?? 0} items in hold`}>
              Hold <strong>{player?.hold.length ?? 0}</strong> / {holdSlots}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * The whole carried inventory, without stopping the game behind it.
 *
 * A held item is selected first, then a bay receives the existing two-second
 * swap request. Drop is separate and immediate. Empty hold slots remain visible
 * so capacity is a shape rather than a number the player has to remember.
 */
export function InventoryPanel({
  player,
  slots,
  holdSlots,
  onUse,
  onSwap,
  onDrop,
  onClose,
}: {
  player: DotBotEntity;
  slots: number;
  holdSlots: number;
  onUse: (bayIndex: number) => void;
  onSwap: (bayIndex: number, holdIndex: number) => void;
  onDrop: (from: "bay" | "hold", index: number, item: Item, revision: number) => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const [selectedHold, setSelectedHold] = useState<number | null>(null);
  const canSwap = player.state === "alive";

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    setSelectedHold(null);
  }, [player.inventoryRevision]);

  useEffect(() => {
    panel.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <aside
      ref={panel}
      id="inventory-panel"
      className="inventory-panel"
      role="dialog"
      aria-modal="false"
      aria-label="Inventory"
    >
      <header>
        <div>
          <strong>Inventory</strong>
          <small>Live · the run continues</small>
        </div>
        <button type="button" onClick={onClose} aria-label="Close inventory">×</button>
      </header>

      <section aria-labelledby="inventory-bays-title">
        <h3 id="inventory-bays-title">Bays</h3>
        <div className="inventory-bays">
          {bayStrip(player.bays, slots).map((item, index) => (
            <div
              className={`inventory-slot ${itemFamily(item)}`}
              key={index}
              aria-label={`Bay ${index + 1}${item ? `: ${itemLabel(item)}` : ": empty"}`}
            >
              <span><small>Bay {index + 1}</small><strong>{itemGlyph(item)}</strong>{item ? itemLabel(item) : "Empty"}</span>
              <div className="inventory-slot-actions">
                <button type="button" onClick={() => onUse(index)} disabled={!item || !canSwap}>Use</button>
                <button
                  type="button"
                  onClick={() => {
                    if (selectedHold === null) return;
                    onSwap(index, selectedHold);
                    setSelectedHold(null);
                  }}
                  disabled={selectedHold === null || !canSwap}
                  aria-label={`Swap selected hold item into bay ${index + 1}`}
                >Swap</button>
                <button
                  type="button"
                  onClick={() => item && onDrop("bay", index, item, player.inventoryRevision ?? 0)}
                  disabled={!item}
                  aria-label={item ? `Drop ${itemLabel(item)} from bay ${index + 1}` : `Bay ${index + 1} is empty`}
                >Drop</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="inventory-hold-title">
        <div className="inventory-hold-heading">
          <h3 id="inventory-hold-title">Hold</h3>
          <span>{player.hold.length} / {holdSlots}</span>
        </div>
        <p className="inventory-guidance" aria-live="polite">
          {canSwap
            ? selectedHold === null ? "Choose a hold item, then a bay to swap." : `Selected hold slot ${selectedHold + 1}. Choose a bay.`
            : "Swap unavailable while downed"}
        </p>
        <div className="inventory-hold">
          {Array.from({ length: holdSlots }, (_, index) => {
            const item = player.hold[index] ?? null;
            return (
              <div
                className={`inventory-slot inventory-hold-slot ${itemFamily(item)} ${selectedHold === index ? "is-selected" : ""}`}
                key={index}
                aria-label={`Hold slot ${index + 1}${item ? `: ${itemLabel(item)}` : ": empty"}`}
              >
                <button
                  type="button"
                  className="inventory-hold-select"
                  disabled={!item || !canSwap}
                  aria-pressed={selectedHold === index}
                  onClick={() => setSelectedHold(selectedHold === index ? null : index)}
                >
                  <small>{index + 1}</small><strong>{itemGlyph(item)}</strong>
                  <span>{item ? itemLabel(item) : "Empty"}</span>
                </button>
                <button
                  type="button"
                  className="inventory-drop"
                  onClick={() => {
                    if (!item) return;
                    onDrop("hold", index, item, player.inventoryRevision ?? 0);
                    setSelectedHold(null);
                  }}
                  disabled={!item}
                  aria-label={item ? `Drop ${itemLabel(item)} from hold slot ${index + 1}` : `Hold slot ${index + 1} is empty`}
                >Drop</button>
              </div>
            );
          })}
        </div>
      </section>
    </aside>
  );
}

/**
 * Choosing what a mark means, at the point you right-clicked.
 *
 * Positioned at the click rather than in a corner, because the whole interaction is "this
 * spot, and this is what about it" — a menu across the screen from the place it refers to
 * makes you look away from the thing you are marking.
 */
export function PingPicker({
  at,
  onChoose,
  onClear,
  onClose,
}: {
  at: { x: number; y: number };
  onChoose: (kind: PingKind) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  /**
   * Escape closes it, and the listener lives here rather than in the game's key handling.
   *
   * The game's keydown handler is for movement and actions and runs whether or not a menu is
   * open; putting a menu's dismissal in it would mean the menu's existence had to be checked
   * from a module that does not own it. Mounted with the menu, removed with it, so the binding
   * cannot outlive what it closes.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    /**
     * A click anywhere else closes it, and must not also place a mark.
     *
     * Bound in the CAPTURE phase for that second reason: the canvas's own `pointerdown` marks
     * wherever you clicked, so a bubbling listener would close the menu and drop a mark in the
     * same gesture. Capturing lets this run first and stop the event before the canvas ever
     * sees it, so dismissing a menu is only ever a dismissal.
     */
    const onDown = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(".ping-picker")) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, { capture: true });
    };
  }, [onClose]);

  return (
    <aside
      className="ping-picker"
      aria-label="Choose a mark"
      style={{ left: at.x, top: at.y }}
    >
      {PING_KINDS.map((kind) => (
        <button key={kind} type="button" onClick={() => onChoose(kind)}>{PING_LABEL[kind]}</button>
      ))}
      <button type="button" className="ping-clear" onClick={onClear}>Cancel all</button>
    </aside>
  );
}

/**
 * Right edge: a section through the building you are in, with your storey marked.
 *
 * The one readout that describes something in the world and stays in a corner anyway.
 * The alternative is lettering each floor inside itself, and a room that tells you it
 * is the sixth floor stops being a room.
 */
export function FloorRail({ column }: { column: FloorColumn }) {
  return (
    <aside className="hud floor-rail" aria-label={`${column.building.name} floor guide`}>
      <span className="floor-rail-name">{column.building.name}</span>
      <ol>
        {column.floors.map((floor) => {
          const isActive = floor.id === column.activeFloorId;
          return (
            <li key={floor.id} className={isActive ? "active" : ""} aria-current={isActive ? "location" : undefined}>
              <span className="floor-label">{floor.label}</span>
              <span className="floor-tick" />
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

/**
 * What the item key left behind.
 *
 * The panel behind `L` used to be a table of marks and their meanings; the marks are on
 * the Dots, so the table went. The sound, haptics and reduced-motion switches were
 * living inside it and are not decoration — reduced motion in particular is somebody's
 * access requirement — so the panel survives with only them in it.
 */
export function SettingsPanel({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <aside className="settings-panel" aria-label="Settings">
      <header>
        <strong>Settings</strong>
        <button type="button" onClick={onClose} aria-label="Close settings">×</button>
      </header>
      {children}
      <small>Press L to close</small>
    </aside>
  );
}

/**
 * Where to start the next run: every arrival point on the map, grouped by region.
 *
 * It sits in front of Restart rather than beside it, and that is the design. A 4200 x 3400
 * world has twelve authored drops in four regions, and until now a run always began at the
 * one authored spawn in the city — so testing anything else meant either a two-minute walk
 * or an `?at=` reload. `?at=` still works and this is the same mechanism with a face on it.
 *
 * Two decisions worth keeping written down:
 *
 *  - IT IS A GATE, so Restart no longer destroys a run on one misclick. `onClose` keeps the
 *    run you are in. That is a behaviour change and it is strictly the safer one.
 *  - ONE ENTRY PER PLACE, in AUTHORED order rather than alphabetical. The regions are
 *    authored in the order the world reads — city, depot, fair, ruin — and a list of place
 *    names is the cheapest possible way to carry that gradient. Sorting throws it away.
 *
 * The names are the map's own (`CAR PARK`, `END OF LINE`, `COAL ROAD`), which is the same
 * rule the rest of the HUD follows: the world already named this ground, so the UI does not
 * get to rename it.
 */
export function SpawnPicker({
  groups,
  current,
  onChoose,
  onDefault,
  onClose,
  canCancel,
}: {
  groups: ArrivalGroup[];
  current: string | null;
  onChoose: (pointId: string) => void;
  onDefault: () => void;
  onClose: () => void;
  canCancel: boolean;
}) {
  // Escape keeps the current run, which is the whole point of the picker being a gate.
  useEffect(() => {
    if (!canCancel) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canCancel, onClose]);

  return (
    <div className="spawn-scrim" role="presentation">
      <aside className="spawn-picker" aria-label="Choose where to start">
        <header>
          <strong>Start where?</strong>
          {canCancel ? (
            <button type="button" onClick={onClose} aria-label="Keep playing this run">×</button>
          ) : null}
        </header>
        <div className="spawn-groups">
          {groups.map((group, index) => (
            <section key={group.area ?? `area-${index}`}>
              {group.area ? <h3>{group.area}</h3> : null}
              <div>
                {group.points.map((point) => (
                  <button
                    type="button"
                    key={point.id}
                    className={point.id === current ? "is-current" : ""}
                    onClick={() => onChoose(point.id)}
                  >
                    {point.name}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
        {/* The authored spawn, kept as its own row: it is not an arrival point, so without
            this the one place the map itself chose to start you becomes unreachable. */}
        <button type="button" className="spawn-default" onClick={onDefault}>
          {current === null ? "↻ Start again where the map starts you" : "Start where the map starts you"}
        </button>
      </aside>
    </div>
  );
}

/** Behind a key, and the one place a number may appear with no world counterpart. */
export function DebugPanel({
  snapshot,
  config,
  networkDebug,
}: {
  snapshot: GameSnapshot;
  config: GameConfig;
  networkDebug: NetworkDebugStats | null | undefined;
}) {
  return (
    <aside className="debug-panel" aria-label="Debug panel">
      <div>FPS {networkDebug?.frameP50Ms ? Math.round(1_000 / networkDebug.frameP50Ms) : snapshot.debug.fps}</div>
      <div>Tick {snapshot.debug.tickCount}</div>
      <div>Bodies {snapshot.debug.activeBodies}</div>
      <div>Dots {snapshot.debug.activeDots}</div>
      <div>Capture {config.dotCaptureDurationMs}ms</div>
      <div>Cover {config.coverDurationMs}ms</div>
      <div>Damage {config.damageSpeed}</div>
      {networkDebug ? (
        <div className="netgraph" aria-label="Network graph">
          <div className="netgraph-spark" aria-label="Snapshot inter-arrival sparkline">
            {arrivalSparkline(networkDebug.snapshotIntervalsMs)}
          </div>
          <div>Snap {Math.round(networkDebug.snapshotP50Ms)}/{Math.round(networkDebug.snapshotP90Ms)}/{Math.round(networkDebug.snapshotP99Ms)}ms p50/90/99</div>
          <div>RTT {networkDebug.rttMs === null ? "—" : `${Math.round(networkDebug.rttMs)}ms`}</div>
          <div>Buffer {networkDebug.bufferDepthSnapshots} @ {networkDebug.interpolationDelayMs}→{networkDebug.interpolationTargetMs}ms</div>
          <div>Error {networkDebug.predictionErrorPx.toFixed(1)}px</div>
          <div>Corrections {networkDebug.correctionsPerSecond}/s</div>
          <div>Frame {Math.round(networkDebug.frameP50Ms)}/{Math.round(networkDebug.frameP90Ms)}/{Math.round(networkDebug.frameP99Ms)}ms p50/90/99 · max {Math.round(networkDebug.frameMaxMs)}</div>
          <div>Work {networkDebug.frameWorkP90Ms.toFixed(1)}ms p90 · max {networkDebug.frameWorkMaxMs.toFixed(1)} · long {networkDebug.longFrameCount}</div>
          <div>Hit draw {networkDebug.hitPresentationP50Ms.toFixed(1)}/{networkDebug.hitPresentationP90Ms.toFixed(1)}/{networkDebug.hitPresentationP99Ms.toFixed(1)}ms p50/90/99</div>
          <div>Hit ack {Math.round(networkDebug.hitConfirmationP50Ms)}/{Math.round(networkDebug.hitConfirmationP90Ms)}/{Math.round(networkDebug.hitConfirmationP99Ms)}ms p50/90/99 · max {Math.round(networkDebug.hitConfirmationMaxMs)}</div>
          <div>Contacts {networkDebug.hitPredictedCount} predicted · {networkDebug.hitConfirmedCount} confirmed · {networkDebug.hitUnconfirmedCount} unconfirmed · {networkDebug.hitPendingCount} pending</div>
        </div>
      ) : null}
    </aside>
  );
}

type Joystick = { active: boolean; knob: { x: number; y: number } };

/** Thumb controls. Present on every surface you can actually move on. */
export function TouchControls({
  joystick,
  joystickHandlers,
  onDash,
  dashProgress,
  dashDisabled,
}: {
  joystick: Joystick;
  joystickHandlers: Record<string, unknown>;
  onDash: () => void;
  dashProgress: number;
  dashDisabled: boolean;
}) {
  return (
    <div className="touch-controls" aria-label="Touch controls">
      <div
        className={`joystick ${joystick.active ? "active" : ""}`}
        role="application"
        aria-label="Movement joystick"
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
          onDash();
        }}
        style={{ "--dash-progress": dashProgress } as React.CSSProperties}
        disabled={dashDisabled}
        aria-label="Dash"
      >
        Dash
      </button>
    </div>
  );
}
