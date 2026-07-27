import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BUILDING_SOURCES } from "@dotbot/game/content/sources";
import type { SourceWall } from "@dotbot/game/mapSource";
import type { SourceEdit } from "@dotbot/game/mapSourcePatch";
import type { ObjectKind, Vec2 } from "@dotbot/game/types";
import { selectMapDocument } from "../mapSelection";
import { StudioCanvas, type CanvasView } from "../studio/StudioCanvas";
import {
  beginSession,
  commit,
  DOT_TRAY,
  editedBuildings,
  findDot,
  findObject,
  handlesFor,
  KIND_SIZE,
  nextId,
  OBJECT_TRAY,
  OPENING_TRAY,
  pendingCount,
  rebuildMap,
  saveSession,
  type Handle,
  type Tool,
} from "../studio/editing";

/**
 * Map Studio — a tweak tool over authored map source.
 *
 * Deliberately not a map editor. The world is built in map source, by hand or by
 * an LLM, because that is what scales and what carries intent. This exists for
 * the edits that are faster to make with a mouse than to describe: nudge that
 * bench, delete that Dot, drop a door in that wall.
 *
 * Two decisions keep it small. It renders through the production map art, so
 * every judgement is made against what a player will actually see — the previous
 * editor drew its own schematic, which meant "does this aisle read as a route"
 * was answered against a picture the game never shows. And it saves by patching
 * the source file rather than regenerating it, so the comments, helpers and named
 * constants an author wrote all survive the round trip.
 */

type Status = { tone: "idle" | "ok" | "warn"; text: string };

const GRIDS = [0, 2, 4, 8, 16];

export function MapStudio() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<StudioCanvas | null>(null);
  const baseMap = useMemo(() => selectMapDocument(window.location.search), []);

  const editable = useMemo(
    () => baseMap.buildings.filter((building) => BUILDING_SOURCES[building.id]).map((building) => building.id),
    [baseMap],
  );
  const session = useMemo(() => beginSession(editable), [editable]);

  const [building, setBuilding] = useState(editable[0] ?? "");
  const [floor, setFloor] = useState("GROUND");
  const [tool, setTool] = useState<Tool>("select");
  const [grid, setGrid] = useState(4);
  const [selection, setSelection] = useState<Handle | null>(null);
  const [kind, setKind] = useState<ObjectKind>("crateStack");
  const [dotIndex, setDotIndex] = useState(0);
  const [openingIndex, setOpeningIndex] = useState(0);
  const [thickness, setThickness] = useState(8);
  const [draft, setDraft] = useState<Vec2[]>([]);
  const [cursor, setCursor] = useState<Vec2>({ x: 0, y: 0 });
  const [pending, setPending] = useState(0);
  const [status, setStatus] = useState<Status>({ tone: "idle", text: "Ready." });
  const [revision, setRevision] = useState(0);

  const source = session.sources[building] ?? null;
  const map = useMemo(() => rebuildMap(baseMap, session), [baseMap, session, revision]);
  const floors = useMemo(() => source?.floors.map((item) => item.label) ?? [], [source, revision]);

  /** Record an edit, then let the canvas and the inspector catch up. */
  const record = useCallback((edit: SourceEdit) => {
    try {
      commit(session, building, edit);
      setPending(pendingCount(session));
      setRevision((value) => value + 1);
      setStatus({ tone: "idle", text: `${edit.op} — unsaved` });
    } catch (error) {
      setStatus({ tone: "warn", text: (error as Error).message });
    }
  }, [building, session]);

  // -------------------------------------------------------------------------
  // Canvas
  // -------------------------------------------------------------------------

  /**
   * The pointer callbacks need the current tool and tray, but the canvas is
   * mounted once. A ref of live handlers keeps both true without re-creating the
   * Pixi application — and losing the camera — on every state change.
   */
  const live = useRef({
    place: (_point: Vec2) => {},
    move: (_handle: Handle, _position: Vec2) => {},
    opening: (_wall: SourceWall, _at: Vec2) => {},
  });

  live.current.move = (handle, position) => {
    record(handle.kind === "object"
      ? { op: "moveObject", floor: handle.floor, id: handle.id, x: position.x, y: position.y }
      : {
        op: "moveDot",
        floor: handle.floor,
        id: handle.id,
        // A Dot's handle is a box around its centre; the edit wants the centre.
        x: position.x + handle.rect.w / 2,
        y: position.y + handle.rect.h / 2,
      });
  };

  live.current.place = (point) => {
    if (!source) return;
    if (tool === "object") {
      const size = KIND_SIZE[kind] ?? { w: 40, h: 40 };
      record({
        op: "addObject",
        floor,
        object: { id: nextId(source, kind), kind, x: point.x, y: point.y, w: size.w, h: size.h },
      });
    } else if (tool === "dot") {
      record({ op: "addDot", floor, dot: { id: nextId(source, "dot"), item: DOT_TRAY[dotIndex].item, x: point.x, y: point.y } });
    }
  };

  live.current.opening = (wall, at) => {
    record({ op: "addOpening", floor, wall: wall.id, opening: { ...OPENING_TRAY[openingIndex].opening, near: at } });
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const canvas = new StudioCanvas();
    canvasRef.current = canvas;
    void canvas.mount(host, {
      onPick: (handle) => setSelection(handle),
      onHover: (point) => setCursor(point),
      onDragEnd: (handle, position) => live.current.move(handle, position),
      onPlace: (point) => live.current.place(point),
      onWallPoint: (point) => setDraft((points) => [...points, point]),
      onOpeningPoint: (wall, at) => live.current.opening(wall, at),
    });
    return () => {
      canvas.dispose();
      canvasRef.current = null;
    };
  }, []);

  const view: CanvasView = useMemo(() => ({
    map, building, floor, grid, tool, selection, draft, source,
  }), [map, building, floor, grid, tool, selection, draft, source]);

  useEffect(() => {
    canvasRef.current?.apply(view);
  }, [view]);

  useEffect(() => {
    const target = map.buildings.find((item) => item.id === building);
    if (target) canvasRef.current?.fit(target.footprint);
    // Fit on building change only; refitting on every edit would fight the author.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [building]);

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      if (event.key === "Escape") {
        setDraft([]);
        setTool("select");
        setSelection(null);
        return;
      }
      if (!selection || !source) return;
      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        record(selection.kind === "object"
          ? { op: "deleteObject", floor: selection.floor, id: selection.id }
          : { op: "deleteDot", floor: selection.floor, id: selection.id });
        setSelection(null);
        return;
      }
      const step = event.shiftKey ? (grid || 1) * 4 : (grid || 1);
      const nudge: Record<string, Vec2> = {
        ArrowLeft: { x: -step, y: 0 },
        ArrowRight: { x: step, y: 0 },
        ArrowUp: { x: 0, y: -step },
        ArrowDown: { x: 0, y: step },
      };
      const delta = nudge[event.key];
      if (!delta) return;
      event.preventDefault();
      if (selection.kind === "object") {
        const object = findObject(source, selection.floor, selection.id);
        if (object) record({ op: "moveObject", floor: selection.floor, id: selection.id, x: object.x + delta.x, y: object.y + delta.y });
      } else {
        const dot = findDot(source, selection.floor, selection.id);
        if (dot) record({ op: "moveDot", floor: selection.floor, id: selection.id, x: dot.x + delta.x, y: dot.y + delta.y });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, grid, source, record]);

  const finishWall = useCallback(() => {
    if (draft.length < 2 || !source) {
      setDraft([]);
      return;
    }
    record({
      op: "addWall",
      floor,
      wall: { id: nextId(source, "wall"), thickness, path: draft.map((point) => ({ x: point.x, y: point.y })) },
    });
    setDraft([]);
  }, [draft, floor, record, source, thickness]);

  const save = useCallback(async () => {
    setStatus({ tone: "idle", text: "Saving…" });
    const outcomes = await saveSession(session);
    setPending(pendingCount(session));
    const failed = outcomes.filter((outcome) => !outcome.ok);
    setStatus(failed.length
      ? { tone: "warn", text: failed.map((outcome) => `${outcome.building}: ${outcome.detail}`).join(" · ") }
      : { tone: "ok", text: `Wrote ${outcomes.map((outcome) => outcome.file.split("/").pop()).join(", ")}` });
  }, [session]);

  const selectedObject = selection?.kind === "object" && source ? findObject(source, selection.floor, selection.id) : null;
  const selectedDot = selection?.kind === "dot" && source ? findDot(source, selection.floor, selection.id) : null;
  const count = source ? handlesFor(source, floor).length : 0;

  const setCoordinate = (axis: "x" | "y", value: number) => {
    if (!selection || Number.isNaN(value)) return;
    if (selectedObject) {
      record({ op: "moveObject", floor: selection.floor, id: selection.id, x: axis === "x" ? value : selectedObject.x, y: axis === "y" ? value : selectedObject.y });
    } else if (selectedDot) {
      record({ op: "moveDot", floor: selection.floor, id: selection.id, x: axis === "x" ? value : selectedDot.x, y: axis === "y" ? value : selectedDot.y });
    }
  };

  if (!editable.length) {
    return (
      <div className="studio studio--empty">
        <p>
          Nothing on <strong>{baseMap.name}</strong> is authored in map source, so there is nothing Studio
          could save. Buildings it can edit live in <code>packages/game/src/content/</code> and are listed
          in <code>content/sources.ts</code>.
        </p>
      </div>
    );
  }

  return (
    <div className="studio">
      <aside className="studio__rail">
        <header className="studio__brand">MAP STUDIO</header>

        <section>
          <h2>Building</h2>
          <select value={building} onChange={(event) => { setBuilding(event.target.value); setSelection(null); setDraft([]); }}>
            {editable.map((id) => (
              <option key={id} value={id}>{BUILDING_SOURCES[id]?.source.name ?? id}</option>
            ))}
          </select>
          <h2>Floor</h2>
          <div className="studio__chips">
            {floors.map((label) => (
              <button
                key={label}
                type="button"
                className={label === floor ? "on" : ""}
                onClick={() => { setFloor(label); setSelection(null); setDraft([]); }}
              >{label}</button>
            ))}
          </div>
        </section>

        <section>
          <h2>Tool</h2>
          <div className="studio__chips">
            {(["select", "object", "dot", "wall", "opening"] as Tool[]).map((item) => (
              <button
                key={item}
                type="button"
                className={item === tool ? "on" : ""}
                onClick={() => { setTool(item); setDraft([]); }}
              >{item}</button>
            ))}
          </div>
          <h2>Snap</h2>
          <div className="studio__chips">
            {GRIDS.map((step) => (
              <button key={step} type="button" className={step === grid ? "on" : ""} onClick={() => setGrid(step)}>
                {step === 0 ? "off" : step}
              </button>
            ))}
          </div>
        </section>

        {tool === "object" && (
          <section className="studio__tray">
            <h2>Object</h2>
            {OBJECT_TRAY.map((group) => (
              <div key={group.group}>
                <h3>{group.group}</h3>
                <div className="studio__chips">
                  {group.kinds.map((item) => (
                    <button key={item} type="button" className={item === kind ? "on" : ""} onClick={() => setKind(item)}>{item}</button>
                  ))}
                </div>
              </div>
            ))}
            <p className="studio__hint">Click the plan to place. The footprint is this kind&rsquo;s usual size; change w/h in the source.</p>
          </section>
        )}

        {tool === "dot" && (
          <section className="studio__tray">
            <h2>Dot</h2>
            <div className="studio__chips">
              {DOT_TRAY.map((entry, index) => (
                <button key={entry.label} type="button" className={index === dotIndex ? "on" : ""} onClick={() => setDotIndex(index)}>{entry.label}</button>
              ))}
            </div>
            <p className="studio__hint">Click the plan to drop a Dot at that point.</p>
          </section>
        )}

        {tool === "opening" && (
          <section className="studio__tray">
            <h2>Opening</h2>
            <div className="studio__chips">
              {OPENING_TRAY.map((entry, index) => (
                <button key={entry.label} type="button" className={index === openingIndex ? "on" : ""} onClick={() => setOpeningIndex(index)}>{entry.label}</button>
              ))}
            </div>
            <p className="studio__hint">Click an interior wall. The opening snaps onto its centreline, and its width is the clear width.</p>
          </section>
        )}

        {tool === "wall" && (
          <section className="studio__tray">
            <h2>Wall</h2>
            <label>
              Thickness
              <input type="number" min={4} max={40} step={2} value={thickness} onChange={(event) => setThickness(Number(event.target.value))} />
            </label>
            <p className="studio__hint">
              Click each corner. A wall is a centreline, so it reaches {thickness / 2} past a free
              end — pull that end in by {thickness / 2} to stop it exactly on a line.
            </p>
            <div className="studio__row">
              <button type="button" onClick={finishWall} disabled={draft.length < 2}>Finish ({draft.length})</button>
              <button type="button" onClick={() => setDraft([])} disabled={!draft.length}>Clear</button>
            </div>
          </section>
        )}

        <section className="studio__spacer" />

        <section className="studio__save">
          <div className="studio__row">
            <button type="button" className="primary" onClick={() => void save()} disabled={!pending}>
              Save{pending ? ` (${pending})` : ""}
            </button>
          </div>
          <p className={`studio__status studio__status--${status.tone}`}>{status.text}</p>
          {pending > 0 && (
            <p className="studio__hint">
              Unsaved in {editedBuildings(session).join(", ")}. Saving patches the source file in place;
              the dev server then reloads it.
            </p>
          )}
        </section>
      </aside>

      <div className="studio__stage" ref={hostRef} />

      <aside className="studio__rail studio__rail--right">
        <section>
          <h2>Selection</h2>
          {!selection && <p className="studio__hint">Click something on the plan. {count} selectable on this floor.</p>}
          {selectedObject && (
            <dl className="studio__props">
              <dt>id</dt><dd className="studio__mono">{selectedObject.id}</dd>
              <dt>kind</dt><dd>{selectedObject.kind}</dd>
              <dt>x</dt><dd><input type="number" value={selectedObject.x} onChange={(event) => setCoordinate("x", Number(event.target.value))} /></dd>
              <dt>y</dt><dd><input type="number" value={selectedObject.y} onChange={(event) => setCoordinate("y", Number(event.target.value))} /></dd>
              <dt>size</dt><dd>{selectedObject.w} × {selectedObject.h}</dd>
              {selectedObject.facing && <><dt>facing</dt><dd>{selectedObject.facing}</dd></>}
              {selectedObject.scannable && <><dt>flags</dt><dd>scannable</dd></>}
            </dl>
          )}
          {selectedDot && (
            <dl className="studio__props">
              <dt>id</dt><dd className="studio__mono">{selectedDot.id}</dd>
              <dt>item</dt><dd>{"type" in selectedDot.item ? String(selectedDot.item.type) : selectedDot.item.kind}</dd>
              <dt>x</dt><dd><input type="number" value={selectedDot.x} onChange={(event) => setCoordinate("x", Number(event.target.value))} /></dd>
              <dt>y</dt><dd><input type="number" value={selectedDot.y} onChange={(event) => setCoordinate("y", Number(event.target.value))} /></dd>
            </dl>
          )}
          {selection && (
            <div className="studio__row">
              <button
                type="button"
                onClick={() => {
                  record(selection.kind === "object"
                    ? { op: "deleteObject", floor: selection.floor, id: selection.id }
                    : { op: "deleteDot", floor: selection.floor, id: selection.id });
                  setSelection(null);
                }}
              >Delete</button>
            </div>
          )}
        </section>

        <section>
          <h2>Cursor</h2>
          <p className="studio__mono">{cursor.x}, {cursor.y}</p>
        </section>

        <section className="studio__spacer" />

        <section>
          <h2>Keys</h2>
          <ul className="studio__keys">
            <li><kbd>drag</kbd> move · <kbd>arrows</kbd> nudge · <kbd>shift</kbd> ×4</li>
            <li><kbd>del</kbd> remove · <kbd>esc</kbd> cancel</li>
            <li><kbd>wheel</kbd> zoom · <kbd>right-drag</kbd> pan</li>
          </ul>
        </section>
      </aside>
    </div>
  );
}
