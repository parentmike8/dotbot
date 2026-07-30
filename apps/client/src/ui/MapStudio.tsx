import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BUILDING_SOURCES,
  studioAreasForMap,
  studioStartForMap,
} from "@dotbot/game/content/sources";
import type { SourceWall } from "@dotbot/game/mapSource";
import type { SourceEdit } from "@dotbot/game/mapSourcePatch";
import type { ObjectKind, Vec2 } from "@dotbot/game/types";
import { selectMapDocument } from "../mapSelection";
import { StudioCanvas, type CanvasView } from "../studio/StudioCanvas";
import {
  beginSession,
  commit,
  commitOutdoor,
  DOT_TRAY,
  editedSources,
  findDot,
  findObject,
  handlesFor,
  outdoorHandles,
  KIND_SIZE,
  loadSessionBaselines,
  nextId,
  nudgeOutdoor,
  OBJECT_TRAY,
  OPENING_TRAY,
  pendingCount,
  rebuildMap,
  reloadSession,
  saveSession,
  undo,
  undoTarget,
  type Handle,
  type Tool,
} from "../studio/editing";
import { buildingChoices, filterBuildings, recentChoices, remember } from "../studio/picker";

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

/**
 * How many buildings before a search box earns its space.
 *
 * Below this the list *is* the answer and a field to filter it is furniture. Not zero,
 * because Downtown has four today and the tool should not grow a search box before there
 * is anything to search — but the list itself replaces the dropdown either way, since the
 * dropdown was the part that could not scale.
 */
const SEARCH_FROM = 6;

export function MapStudio() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<StudioCanvas | null>(null);
  const baseMap = useMemo(() => selectMapDocument(window.location.search), []);
  const studioAreas = useMemo(() => studioAreasForMap(baseMap), [baseMap]);
  const start = useMemo(() => studioStartForMap(baseMap), [baseMap]);

  const editable = useMemo(
    () => baseMap.buildings.filter((building) => BUILDING_SOURCES[building.id]).map((building) => building.id),
    [baseMap],
  );
  const session = useMemo(() => beginSession(editable, baseMap), [editable, baseMap]);

  const [building, setBuilding] = useState(start.building || editable[0] || "");
  const [context, setContext] = useState<"area" | "building">(start.context);
  const [areaId, setAreaId] = useState(start.areaId);
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
  const [query, setQuery] = useState("");
  const [recents, setRecents] = useState<string[]>(() => (editable[0] ? [editable[0]] : []));
  const [showCollision, setShowCollision] = useState(false);
  const [showClearance, setShowClearance] = useState(false);
  const [baselinesReady, setBaselinesReady] = useState(false);

  const choices = useMemo(() => buildingChoices(baseMap, editable), [baseMap, editable]);
  const matches = useMemo(() => filterBuildings(choices, query), [choices, query]);
  const recent = useMemo(() => recentChoices(choices, recents), [choices, recents]);

  useEffect(() => {
    setBaselinesReady(false);
    void loadSessionBaselines(session)
      .then(() => setBaselinesReady(true))
      .catch((error: unknown) => {
        setStatus({ tone: "warn", text: `Source read error: ${(error as Error).message}` });
      });
  }, [session]);

  /** Open a building: remember it, and drop anything that pointed into the last one. */
  const openBuilding = useCallback((id: string) => {
    setContext("building");
    setBuilding(id);
    setRecents((list) => remember(list, id));
    setSelection(null);
    setDraft([]);
  }, []);

  const area = studioAreas.find((entry) => entry.id === areaId) ?? studioAreas[0];
  const source = context === "building" ? session.sources[building] ?? null : null;
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

  const recordOutdoor = useCallback((edit: Parameters<typeof commitOutdoor>[1]) => {
    try {
      commitOutdoor(session, edit);
      setPending(pendingCount(session));
      setRevision((value) => value + 1);
      setStatus({ tone: "idle", text: `${edit.op} — unsaved` });
    } catch (error) {
      setStatus({ tone: "warn", text: (error as Error).message });
    }
  }, [session]);

  /**
   * Take back the last edit, wherever it was made.
   *
   * It switches the view to the building being unwound. Undoing something on a floor you
   * cannot see would look like nothing happening, which is worse than no undo — and
   * `undoTarget` knows which building it is, so there is no reason to guess.
   *
   * Selection is cleared because the thing selected may be the thing that just stopped
   * existing, and an inspector pointing at a deleted id is the sort of stale handle that
   * throws two clicks later.
   */
  const takeBack = useCallback(() => {
    const result = undo(session);
    if (!result) {
      setStatus({ tone: "idle", text: "Nothing to undo." });
      return;
    }
    setBuilding(result.building);
    setSelection(null);
    setDraft([]);
    setPending(pendingCount(session));
    setRevision((value) => value + 1);
    setStatus({ tone: "idle", text: `Undid one edit in ${result.building}.` });
  }, [session]);

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
    if (handle.kind === "outdoorObject" && handle.source?.kind === "authored") {
      recordOutdoor({
        op: "moveOutdoorObject",
        id: handle.id,
        source: handle.source,
        x: position.x,
        y: position.y,
      });
    } else if (handle.kind === "object") {
      record({ op: "moveObject", floor: handle.floor, id: handle.id, x: position.x, y: position.y });
    } else if (handle.kind === "dot") {
      record({
        op: "moveDot",
        floor: handle.floor,
        id: handle.id,
        // A Dot's handle is a box around its centre; the edit wants the centre.
        x: position.x + handle.rect.w / 2,
        y: position.y + handle.rect.h / 2,
      });
    }
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
    }).catch((error: unknown) => {
      console.error("Map Studio canvas failed to mount", error);
      setStatus({ tone: "warn", text: `Canvas error: ${(error as Error).message}` });
    });
    return () => {
      canvas.dispose();
      canvasRef.current = null;
    };
  }, []);

  const view: CanvasView = useMemo(() => ({
    map,
    building: context === "building" ? building : null,
    floor: context === "building" ? floor : null,
    area: context === "area" ? area?.bounds ?? null : null,
    grid,
    tool: context === "area" ? "select" : tool,
    selection,
    draft,
    source,
    showCollision,
    showClearance,
  }), [map, context, building, floor, area, grid, tool, selection, draft, source, showCollision, showClearance]);

  useEffect(() => {
    canvasRef.current?.apply(view);
  }, [view]);

  useEffect(() => {
    if (context === "area") {
      if (area) canvasRef.current?.fit(area.bounds);
    } else {
      const target = map.buildings.find((item) => item.id === building);
      if (target) canvasRef.current?.fit(target.footprint);
    }
    // Fit on building change only; refitting on every edit would fight the author.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [building, context, areaId]);

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      /**
       * Before the selection guard, because undo has to work when nothing is selected —
       * which is most of the time, and always right after a delete.
       */
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        takeBack();
        return;
      }
      if (event.key === "Escape") {
        setDraft([]);
        setTool("select");
        setSelection(null);
        return;
      }
      if (!selection) return;
      if (event.key === "Backspace" || event.key === "Delete") {
        if (selection.kind !== "object" && selection.kind !== "dot") return;
        if (!source) return;
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
      if (selection.kind === "outdoorObject" && selection.source?.kind === "authored") {
        try {
          nudgeOutdoor(session, selection, delta);
          setPending(pendingCount(session));
          setRevision((value) => value + 1);
          setStatus({ tone: "idle", text: "moveOutdoorObject — unsaved" });
        } catch (error) {
          setStatus({ tone: "warn", text: (error as Error).message });
        }
      } else if (selection.kind === "object" && source) {
        const object = findObject(source, selection.floor, selection.id);
        if (object) record({ op: "moveObject", floor: selection.floor, id: selection.id, x: object.x + delta.x, y: object.y + delta.y });
      } else if (selection.kind === "dot" && source) {
        const dot = findDot(source, selection.floor, selection.id);
        if (dot) record({ op: "moveDot", floor: selection.floor, id: selection.id, x: dot.x + delta.x, y: dot.y + delta.y });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, grid, source, session, record, takeBack]);

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
  const selectedOutdoor = selection?.kind === "outdoorObject"
    ? map.outdoor.objects.find((object) => object.id === selection.id) ?? null
    : null;
  const count = context === "area" && area
    ? outdoorHandles(map, area.bounds).length
    : source ? handlesFor(source, floor).length : 0;

  const setCoordinate = (axis: "x" | "y", value: number) => {
    if (!selection || Number.isNaN(value)) return;
    if (selectedObject) {
      record({ op: "moveObject", floor: selection.floor, id: selection.id, x: axis === "x" ? value : selectedObject.x, y: axis === "y" ? value : selectedObject.y });
    } else if (selectedDot) {
      record({ op: "moveDot", floor: selection.floor, id: selection.id, x: axis === "x" ? value : selectedDot.x, y: axis === "y" ? value : selectedDot.y });
    } else if (selectedOutdoor && selection.kind === "outdoorObject" && selection.source?.kind === "authored") {
      recordOutdoor({
        op: "moveOutdoorObject",
        id: selection.id,
        source: selection.source,
        x: axis === "x" ? value : selectedOutdoor.x,
        y: axis === "y" ? value : selectedOutdoor.y,
      });
    }
  };

  /**
   * Resize the selected object.
   *
   * Guarded at 4 units because a zero-width fixture is a solid with no silhouette — you
   * cannot see it, you cannot click it again to fix it, and the audits will report it as
   * every kind of fault at once. The contract's smallest authored fixture is a 16-unit
   * sink, so 4 is well below anything real and still above nothing.
   */
  const setSize = (axis: "w" | "h", value: number) => {
    if (!selection || !selectedObject || Number.isNaN(value) || value < 4) return;
    record({
      op: "resizeObject",
      floor: selection.floor,
      id: selection.id,
      w: axis === "w" ? value : selectedObject.w,
      h: axis === "h" ? value : selectedObject.h,
    });
  };

  const setOutdoorSize = (axis: "w" | "h", value: number) => {
    if (!selection || selection.kind !== "outdoorObject" || selection.source?.kind !== "authored"
      || !selectedOutdoor || Number.isNaN(value) || value < 4) return;
    recordOutdoor({
      op: "resizeOutdoorObject",
      id: selection.id,
      source: selection.source,
      w: axis === "w" ? value : selectedOutdoor.w,
      h: axis === "h" ? value : selectedOutdoor.h,
    });
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

        {studioAreas.length > 0 && <section>
          <h2>Outdoor context</h2>
          <div className="studio__chips">
            {studioAreas.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={context === "area" && entry.id === areaId ? "on" : ""}
                onClick={() => {
                  setContext("area");
                  setAreaId(entry.id);
                  setSelection(null);
                  setDraft([]);
                  setTool("select");
                }}
              >{entry.name}</button>
            ))}
          </div>
          <p className="studio__hint">Production streets, ground, buildings, objects, pads and spawns.</p>
          <h2>Overlays</h2>
          <div className="studio__chips">
            <button type="button" className={showCollision ? "on" : ""} onClick={() => setShowCollision((value) => !value)}>
              collision
            </button>
            <button type="button" className={showClearance ? "on" : ""} onClick={() => setShowClearance((value) => !value)}>
              bot clearance
            </button>
          </div>
        </section>}

        <section>
          <h2>Building</h2>
          {/*
            A search box and a list, not a dropdown. Four buildings fit in a `<select>`;
            ninety do not, and ninety is the target — see `studio/picker.ts`. The search
            field only appears once there are enough to hunt through, so the small case
            stays as quiet as it was.
          */}
          {choices.length > SEARCH_FROM && (
            <input
              type="search"
              value={query}
              placeholder="Search name, id or kind"
              onChange={(event) => setQuery(event.target.value)}
            />
          )}
          {recent.length > 1 && !query && (
            <div className="studio__chips studio__recent">
              {recent.map((choice) => (
                <button
                  key={choice.id}
                  type="button"
                  className={choice.id === building ? "on" : ""}
                  onClick={() => openBuilding(choice.id)}
                >{choice.name}</button>
              ))}
            </div>
          )}
          <div className="studio__chips">
            {matches.map((choice) => (
              <button
                key={choice.id}
                type="button"
                className={choice.id === building ? "on" : ""}
                onClick={() => openBuilding(choice.id)}
              >{choice.name}</button>
            ))}
            {!matches.length && <p className="studio__hint">Nothing matches “{query}”.</p>}
          </div>
          {context === "building" && <>
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
          </>}
        </section>

        {context === "building" && <section>
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
        </section>}

        {context === "building" && tool === "object" && (
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

        {context === "building" && tool === "dot" && (
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

        {context === "building" && tool === "opening" && (
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

        {context === "building" && tool === "wall" && (
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
            <button type="button" onClick={takeBack} disabled={!undoTarget(session)}>Undo</button>
            <button
              type="button"
              onClick={() => {
                reloadSession(session, baseMap);
                setSelection(null);
                setDraft([]);
                setPending(0);
                setRevision((value) => value + 1);
                setBaselinesReady(false);
                setStatus({ tone: "idle", text: "Reloading production source; unsaved edits discarded." });
                void loadSessionBaselines(session)
                  .then(() => {
                    setBaselinesReady(true);
                    setStatus({ tone: "idle", text: "Reloaded production source; unsaved edits discarded." });
                  })
                  .catch((error: unknown) => {
                    setStatus({ tone: "warn", text: `Source read error: ${(error as Error).message}` });
                  });
              }}
              disabled={!pending}
            >Reload</button>
            <button type="button" className="primary" onClick={() => void save()} disabled={!pending || !baselinesReady}>
              Save{pending ? ` (${pending})` : ""}
            </button>
          </div>
          <p className={`studio__status studio__status--${status.tone}`}>{status.text}</p>
          {pending > 0 && (
            <p className="studio__hint">
              Unsaved in {editedSources(session).join(", ")}. Saving patches the source file in place;
              the dev server then reloads it.
            </p>
          )}
        </section>
      </aside>

      <div className="studio__stage" ref={hostRef} />

      <aside className="studio__rail studio__rail--right">
        <section>
          <h2>Selection</h2>
          {!selection && (
            <p className="studio__hint">
              Click something on the plan. {count} selectable on this {context === "area" ? "area" : "floor"}.
            </p>
          )}
          {selectedObject && (
            <dl className="studio__props">
              <dt>id</dt><dd className="studio__mono">{selectedObject.id}</dd>
              <dt>kind</dt><dd>{selectedObject.kind}</dd>
              <dt>x</dt><dd><input type="number" value={selectedObject.x} onChange={(event) => setCoordinate("x", Number(event.target.value))} /></dd>
              <dt>y</dt><dd><input type="number" value={selectedObject.y} onChange={(event) => setCoordinate("y", Number(event.target.value))} /></dd>
              <dt>w</dt><dd><input type="number" min={4} step={2} value={selectedObject.w} onChange={(event) => setSize("w", Number(event.target.value))} /></dd>
              <dt>h</dt><dd><input type="number" min={4} step={2} value={selectedObject.h} onChange={(event) => setSize("h", Number(event.target.value))} /></dd>
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
          {selectedOutdoor && selection?.kind === "outdoorObject" && (
            <>
              <dl className="studio__props">
                <dt>id</dt><dd className="studio__mono">{selectedOutdoor.id}</dd>
                <dt>kind</dt><dd>{selectedOutdoor.kind}</dd>
                <dt>source</dt><dd className="studio__mono">{selection.source?.file.split("/").pop() ?? "runtime/composed"}</dd>
                {selection.source?.kind === "authored" ? <>
                  <dt>placed</dt><dd>individually authored</dd>
                  <dt>x</dt><dd><input type="number" value={selectedOutdoor.x} onChange={(event) => setCoordinate("x", Number(event.target.value))} /></dd>
                  <dt>y</dt><dd><input type="number" value={selectedOutdoor.y} onChange={(event) => setCoordinate("y", Number(event.target.value))} /></dd>
                  <dt>w</dt><dd><input type="number" min={4} step={2} value={selectedOutdoor.w} onChange={(event) => setOutdoorSize("w", Number(event.target.value))} /></dd>
                  <dt>h</dt><dd><input type="number" min={4} step={2} value={selectedOutdoor.h} onChange={(event) => setOutdoorSize("h", Number(event.target.value))} /></dd>
                </> : selection.source?.kind === "derived" ? <>
                  <dt>placed by</dt><dd>{selection.source.rule.label}</dd>
                  <dt>source rule</dt><dd className="studio__mono">{selection.source.rule.expression}</dd>
                  <dt>axis</dt><dd>{selection.source.rule.axis}</dd>
                  <dt>from</dt><dd>{selection.source.rule.from}</dd>
                  <dt>to</dt><dd>{selection.source.rule.to}</dd>
                  <dt>spacing</dt><dd>{selection.source.rule.spacing}</dd>
                  <dt>gaps</dt><dd className="studio__mono">{JSON.stringify(selection.source.rule.gaps)}</dd>
                </> : <>
                  <dt>placed</dt><dd>composed/runtime</dd>
                </>}
                {selectedOutdoor.facing && <><dt>facing</dt><dd>{selectedOutdoor.facing}</dd></>}
                {selectedOutdoor.angle !== undefined && <><dt>angle</dt><dd>{selectedOutdoor.angle}</dd></>}
                {selectedOutdoor.collisionParts && <><dt>collision</dt><dd>{selectedOutdoor.collisionParts.length} authored part(s)</dd></>}
              </dl>
              {selection.source?.kind === "derived" && (
                <p className="studio__hint">
                  Inspection only. Change the named rhythm parameters in {selection.source.file}; dragging would unroll the rule into a lie.
                </p>
              )}
            </>
          )}
          {selection && ["insertion", "extraction", "botSpawn"].includes(selection.kind) && (
            <>
              <dl className="studio__props">
                <dt>id</dt><dd className="studio__mono">{selection.id}</dd>
                <dt>kind</dt><dd>{selection.kind === "botSpawn" ? "bot spawn" : `${selection.kind} point`}</dd>
                <dt>source</dt><dd className="studio__mono">{"source" in selection ? selection.source?.file.split("/").pop() ?? "composed" : "composed"}</dd>
              </dl>
              <p className="studio__hint">
                Inspection only. This point is authored in source; Studio does not expose a semantic point patch yet.
                {selection.kind !== "outdoorObject" && selection.source?.note ? ` ${selection.source.note}` : ""}
              </p>
            </>
          )}
          {selection && (selection.kind === "object" || selection.kind === "dot") && (
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
            {context === "area" ? <>
              <li><kbd>drag</kbd> move authored · <kbd>arrows</kbd> nudge · <kbd>shift</kbd> ×4</li>
              <li>orange outlines inspect rules and semantic points only</li>
            </> : <>
              <li><kbd>drag</kbd> move · <kbd>arrows</kbd> nudge · <kbd>shift</kbd> ×4</li>
              <li><kbd>del</kbd> remove · <kbd>esc</kbd> cancel · <kbd>⌘Z</kbd> undo</li>
            </>}
            <li><kbd>wheel</kbd> zoom · <kbd>right-drag</kbd> pan</li>
          </ul>
        </section>
      </aside>
    </div>
  );
}
