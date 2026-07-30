import { compileBuilding, type SourceBuilding, type SourceDot, type SourceObject, type SourceOpening, type SourceWall } from "@dotbot/game/mapSource";
import { applyEdits, type SourceEdit } from "@dotbot/game/mapSourcePatch";
import {
  applyOutdoorEdits,
  type OutdoorSourceEdit,
} from "@dotbot/game/outdoorSource";
import { BUILDING_SOURCES } from "@dotbot/game/content/sources";
import type {
  Building,
  MapDocument,
  ObjectKind,
  OutdoorSource,
  Rect,
  Vec2,
} from "@dotbot/game/types";

/**
 * Map Studio's editing model.
 *
 * The idea that makes this a small tool rather than a second map pipeline: an
 * edit is expressed once, as a `SourceEdit`, and then used twice — applied to an
 * in-memory `SourceBuilding` so the canvas updates on the same frame, and
 * replayed against the file's text on save. There is no separate editor document
 * that could drift from what gets written.
 *
 * Everything here is pure. The canvas and the React shell hold no editing logic.
 */

export type Selection =
  | { kind: "object"; building: string; floor: string; id: string }
  | { kind: "dot"; building: string; floor: string; id: string }
  | null;

export type Tool = "select" | "object" | "dot" | "wall" | "opening";

export type StudioSession = {
  /** Deep copies, mutated as edits land, so the registry is never touched. */
  sources: Record<string, SourceBuilding>;
  /** Every edit made this session, in order, per building. */
  edits: Record<string, SourceEdit[]>;
  /**
   * Which building each edit went to, in the order they were made.
   *
   * The per-building logs are what the save path replays, and they cannot answer "what
   * did I just do" once you have touched two buildings. This can, so undo means the last
   * thing you actually did rather than the last thing you did *here*.
   */
  order: Array<{ kind: "building"; key: string } | { kind: "outdoor"; key: string }>;
  /** Pristine production outdoor objects; replay is the undo/reload mechanism. */
  outdoorBase: MapDocument["outdoor"]["objects"];
  outdoorObjects: MapDocument["outdoor"]["objects"];
  outdoorEdits: Record<string, OutdoorSourceEdit[]>;
  /** Exact source text loaded when Studio opened; dirty files are refused. */
  fileBases: Record<string, string>;
};

export function beginSession(buildingIds: readonly string[], baseMap?: MapDocument): StudioSession {
  const sources: Record<string, SourceBuilding> = {};
  for (const id of buildingIds) {
    const entry = BUILDING_SOURCES[id];
    if (entry) sources[id] = structuredClone(entry.source);
  }
  const outdoorBase = structuredClone(baseMap?.outdoor.objects ?? []);
  return {
    sources,
    edits: {},
    order: [],
    outdoorBase,
    outdoorObjects: structuredClone(outdoorBase),
    outdoorEdits: {},
    fileBases: {},
  };
}

export function pendingCount(session: StudioSession): number {
  return Object.values(session.edits).reduce((total, list) => total + list.length, 0)
    + Object.values(session.outdoorEdits).reduce((total, list) => total + list.length, 0);
}

export function editedBuildings(session: StudioSession): string[] {
  return Object.entries(session.edits).filter(([, list]) => list.length > 0).map(([id]) => id);
}

export function editedSources(session: StudioSession): string[] {
  const buildings = editedBuildings(session);
  const outdoorFiles = Object.entries(session.outdoorEdits)
    .filter(([, list]) => list.length > 0)
    .map(([file]) => file.split("/").at(-1) ?? file);
  return [...buildings, ...outdoorFiles];
}

// ---------------------------------------------------------------------------
// Applying an edit to the in-memory source
// ---------------------------------------------------------------------------

function floorOf(source: SourceBuilding, label: string) {
  const floor = source.floors.find((candidate) => candidate.label === label);
  if (!floor) throw new Error(`${source.id} has no floor ${label}`);
  return floor;
}

/**
 * Mutate the in-memory source the same way the file patch will, so what the
 * canvas shows and what lands on disk cannot disagree.
 */
function mutate(source: SourceBuilding, edit: SourceEdit): void {
  switch (edit.op) {
    case "moveObject": {
      const object = floorOf(source, edit.floor).objects?.find((item) => item.id === edit.id);
      if (object) {
        object.x = edit.x;
        object.y = edit.y;
      }
      return;
    }
    case "moveDot": {
      const dot = floorOf(source, edit.floor).dots?.find((item) => item.id === edit.id);
      if (dot) {
        dot.x = edit.x;
        dot.y = edit.y;
      }
      return;
    }
    case "resizeObject": {
      const object = floorOf(source, edit.floor).objects?.find((item) => item.id === edit.id);
      if (object) {
        object.w = edit.w;
        object.h = edit.h;
      }
      return;
    }
    case "deleteObject": {
      const floor = floorOf(source, edit.floor);
      floor.objects = (floor.objects ?? []).filter((item) => item.id !== edit.id);
      return;
    }
    case "deleteDot": {
      const floor = floorOf(source, edit.floor);
      floor.dots = (floor.dots ?? []).filter((item) => item.id !== edit.id);
      return;
    }
    case "addObject": {
      const floor = floorOf(source, edit.floor);
      floor.objects = [...(floor.objects ?? []), edit.object];
      return;
    }
    case "addDot": {
      const floor = floorOf(source, edit.floor);
      floor.dots = [...(floor.dots ?? []), edit.dot];
      return;
    }
    case "addWall": {
      const floor = floorOf(source, edit.floor);
      floor.walls = [...(floor.walls ?? []), edit.wall];
      return;
    }
    case "addOpening": {
      const wall = floorOf(source, edit.floor).walls?.find((item) => item.id === edit.wall);
      if (wall) wall.openings = [...(wall.openings ?? []), edit.opening];
      return;
    }
    case "addStair":
      source.stairs = [...(source.stairs ?? []), edit.stair];
      return;
    default: {
      const never: never = edit;
      throw new Error(`Unknown edit ${JSON.stringify(never)}`);
    }
  }
}

/** Record an edit and return the rebuilt building. */
export function commit(session: StudioSession, building: string, edit: SourceEdit): Building {
  const source = session.sources[building];
  if (!source) throw new Error(`${building} is not an editable source building`);
  mutate(source, edit);
  session.edits[building] = [...(session.edits[building] ?? []), edit];
  session.order = [...session.order, { kind: "building", key: building }];
  return compileBuilding(source);
}

function mutateOutdoor(objects: MapDocument["outdoor"]["objects"], edit: OutdoorSourceEdit): void {
  if (edit.source?.kind !== "authored") {
    throw new Error(`${edit.id} is placed by a rule and cannot be dragged; change the placing rule.`);
  }
  const object = objects.find((candidate) => candidate.id === edit.id);
  if (!object) throw new Error(`Outdoor object ${edit.id} is no longer in this map; reload Studio.`);
  if (object.source?.kind !== "authored"
    || object.source.file !== edit.source.file
    || object.source.ordinal !== edit.source.ordinal) {
    throw new Error(`${edit.id} source ownership changed; reload Studio before editing it.`);
  }
  if (edit.op === "moveOutdoorObject") {
    object.x = edit.x;
    object.y = edit.y;
  } else {
    object.w = edit.w;
    object.h = edit.h;
  }
}

export function commitOutdoor(session: StudioSession, edit: OutdoorSourceEdit): void {
  mutateOutdoor(session.outdoorObjects, edit);
  const file = edit.source.file;
  session.outdoorEdits[file] = [...(session.outdoorEdits[file] ?? []), edit];
  session.order = [...session.order, { kind: "outdoor", key: file }];
}

/** Which building the next undo would touch, or null when there is nothing to undo. */
export function undoTarget(session: StudioSession): string | null {
  return session.order[session.order.length - 1]?.key ?? null;
}

/**
 * Take back the last edit, by replaying the log without it.
 *
 * REPLAY, NOT AN INVERSE. The task that asked for this proposed an inverse-edit stack,
 * and that is the harder and more fragile of the two: the inverse of `addOpening` has to
 * know whether the wall had an `openings` array before it ran, the inverse of `addObject`
 * has to know where in the list it went, and every future edit op has to remember to
 * bring its own inverse or undo silently stops being faithful.
 *
 * None of that is needed here, because the session already holds everything required to
 * rebuild from scratch: the registry source is pristine and untouched, and `edits` is the
 * complete ordered list applied to a clone of it. So dropping the last entry and replaying
 * is exact by construction, for every op that exists and every op anyone adds.
 *
 * It is also the only version that cannot desync from what gets written. The save path
 * replays the same `edits` list against the file text — so an undo that removes an edit
 * from the log has already undone it on disk, and there is no second representation to
 * keep in step. That invariant is the whole design of this tool.
 *
 * The cost is a replay per undo: N `mutate` calls and one `compileBuilding`. A compile
 * already happens on every single edit, so an undo costs about what one edit costs.
 */
export function undo(session: StudioSession): { building: string; rebuilt: Building } | null {
  const target = session.order[session.order.length - 1];
  if (!target) return null;

  if (target.kind === "outdoor") {
    session.outdoorEdits[target.key] = (session.outdoorEdits[target.key] ?? []).slice(0, -1);
    session.order = session.order.slice(0, -1);
    session.outdoorObjects = structuredClone(session.outdoorBase);
    for (const edits of Object.values(session.outdoorEdits)) {
      for (const edit of edits) mutateOutdoor(session.outdoorObjects, edit);
    }
    return { building: "outdoor", rebuilt: null as never };
  }

  const building = target.key;
  const remaining = (session.edits[building] ?? []).slice(0, -1);
  const entry = BUILDING_SOURCES[building];
  if (!entry) throw new Error(`${building} is not an editable source building`);

  const source = structuredClone(entry.source);
  for (const edit of remaining) mutate(source, edit);

  session.sources[building] = source;
  session.edits[building] = remaining;
  session.order = session.order.slice(0, -1);
  return { building, rebuilt: compileBuilding(source) };
}

/** The map with every in-memory source swapped in for its shipped build. */
export function rebuildMap(base: MapDocument, session: StudioSession): MapDocument {
  return {
    ...base,
    outdoor: {
      ...base.outdoor,
      objects: session.outdoorBase.length ? session.outdoorObjects : base.outdoor.objects,
    },
    buildings: base.buildings.map((building) =>
      session.sources[building.id] ? compileBuilding(session.sources[building.id]) : building),
  };
}

/** Discard every unsaved edit and rebuild from the production module snapshot. */
export function reloadSession(session: StudioSession, baseMap?: MapDocument): void {
  for (const id of Object.keys(session.sources)) {
    const entry = BUILDING_SOURCES[id];
    if (entry) session.sources[id] = structuredClone(entry.source);
  }
  session.edits = {};
  session.order = [];
  if (baseMap) session.outdoorBase = structuredClone(baseMap.outdoor.objects);
  session.outdoorObjects = structuredClone(session.outdoorBase);
  session.outdoorEdits = {};
}

/** Capture the disk revisions this Studio session is editing. */
export async function loadSessionBaselines(session: StudioSession): Promise<void> {
  const files = new Set<string>([
    ...Object.keys(session.sources).map((id) => BUILDING_SOURCES[id]?.file).filter((file): file is string => Boolean(file)),
    ...session.outdoorBase.map((object) => object.source?.file).filter((file): file is string => Boolean(file)),
  ]);
  for (const file of files) {
    const read = await fetch(`/__studio/read?file=${encodeURIComponent(file)}`, { cache: "no-store" });
    const body = (await read.json()) as { ok: boolean; text?: string; error?: string };
    if (!body.ok || body.text === undefined) throw new Error(body.error ?? `Could not read ${file}`);
    session.fileBases[file] = body.text;
  }
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

export type SaveOutcome = { building: string; file: string; ok: boolean; detail: string };

/**
 * Replay this session's edits against the text on disk, one file per building.
 *
 * Read-patch-write rather than read-once-at-start: the file is fetched at save
 * time and sent back as the base, so a file an LLM changed while Studio was open
 * is refused rather than overwritten.
 */
export async function saveSession(session: StudioSession): Promise<SaveOutcome[]> {
  const results: SaveOutcome[] = [];
  for (const building of editedBuildings(session)) {
    const entry = BUILDING_SOURCES[building];
    const file = entry?.file ?? "";
    try {
      if (!entry) throw new Error("no source file registered");
      const read = await fetch(`/__studio/read?file=${encodeURIComponent(file)}`, { cache: "no-store" });
      const readBody = (await read.json()) as { ok: boolean; text?: string; error?: string };
      if (!readBody.ok || readBody.text === undefined) throw new Error(readBody.error ?? "could not read the file");
      if (session.fileBases[file] === undefined) {
        throw new Error(`${file} has no loaded source baseline. Reload before saving.`);
      }
      if (session.fileBases[file] !== readBody.text) {
        throw new Error(`${file} changed on disk since Studio loaded it. Reload before saving.`);
      }

      const next = applyEdits(readBody.text, session.edits[building]);
      const write = await fetch("/__studio/write", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file, text: next, base: readBody.text }),
      });
      const writeBody = (await write.json()) as { ok: boolean; error?: string };
      if (!writeBody.ok) throw new Error(writeBody.error ?? "could not write the file");

      results.push({ building, file, ok: true, detail: `${session.edits[building].length} edit(s) written` });
      session.fileBases[file] = next;
      session.edits[building] = [];
      session.order = session.order.filter((entry) => !(entry.kind === "building" && entry.key === building));
    } catch (error) {
      results.push({ building, file, ok: false, detail: (error as Error).message });
    }
  }
  for (const [file, edits] of Object.entries(session.outdoorEdits).filter(([, list]) => list.length)) {
    try {
      const read = await fetch(`/__studio/read?file=${encodeURIComponent(file)}`, { cache: "no-store" });
      const readBody = (await read.json()) as { ok: boolean; text?: string; error?: string };
      if (!readBody.ok || readBody.text === undefined) throw new Error(readBody.error ?? "could not read the file");
      if (session.fileBases[file] === undefined) {
        throw new Error(`${file} has no loaded source baseline. Reload before saving.`);
      }
      if (session.fileBases[file] !== readBody.text) {
        throw new Error(`${file} changed on disk since Studio loaded it. Reload before saving.`);
      }
      const next = applyOutdoorEdits(readBody.text, edits);
      const write = await fetch("/__studio/write", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file, text: next, base: readBody.text }),
      });
      const writeBody = (await write.json()) as { ok: boolean; error?: string };
      if (!writeBody.ok) throw new Error(writeBody.error ?? "could not write the file");
      results.push({ building: "outdoor", file, ok: true, detail: `${edits.length} edit(s) written` });
      session.fileBases[file] = next;
      session.outdoorEdits[file] = [];
      session.order = session.order.filter((entry) => !(entry.kind === "outdoor" && entry.key === file));
    } catch (error) {
      results.push({ building: "outdoor", file, ok: false, detail: (error as Error).message });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Hit testing and geometry the canvas needs
// ---------------------------------------------------------------------------

export type Handle =
  | { kind: "object"; building: string; floor: string; id: string; rect: Rect; source?: null; movable?: true; resizable?: true }
  | { kind: "dot"; building: string; floor: string; id: string; rect: Rect; source?: null; movable?: true; resizable?: false }
  | {
    kind: "outdoorObject";
    building: "outdoor";
    floor: "outdoor";
    id: string;
    rect: Rect;
    source: OutdoorSource | null;
    movable: boolean;
    resizable: boolean;
  }
  | {
    kind: "insertion" | "extraction" | "botSpawn";
    building: "outdoor";
    floor: "outdoor";
    id: string;
    rect: Rect;
    source: { kind: "authored" | "composed"; file: string; note?: string } | null;
    movable: false;
    resizable: false;
  };

const DOT_HANDLE = 18;

/** Everything selectable on one floor of one building, topmost last. */
export function handlesFor(source: SourceBuilding, floorLabel: string): Handle[] {
  const floor = source.floors.find((candidate) => candidate.label === floorLabel);
  if (!floor) return [];
  return [
    ...(floor.objects ?? []).map((object): Handle => ({
      kind: "object",
      building: source.id,
      floor: floorLabel,
      id: object.id,
      rect: { x: object.x, y: object.y, w: object.w, h: object.h },
    })),
    ...(floor.dots ?? []).map((dot): Handle => ({
      kind: "dot",
      building: source.id,
      floor: floorLabel,
      id: dot.id,
      rect: { x: dot.x - DOT_HANDLE, y: dot.y - DOT_HANDLE, w: DOT_HANDLE * 2, h: DOT_HANDLE * 2 },
    })),
  ];
}

function intersects(left: Rect, right: Rect): boolean {
  return left.x <= right.x + right.w && left.x + left.w >= right.x
    && left.y <= right.y + right.h && left.y + left.h >= right.y;
}

const POINT_HANDLE = 24;

/** Outdoor production entities in one review area, authored and derived alike. */
export function outdoorHandles(map: MapDocument, area: Rect): Handle[] {
  const objects: Handle[] = map.outdoor.objects
    .filter((object) => intersects(object, area))
    .map((object) => {
      const source = object.source ?? null;
      const editable = source?.kind === "authored";
      return {
        kind: "outdoorObject" as const,
        building: "outdoor" as const,
        floor: "outdoor" as const,
        id: object.id,
        rect: { x: object.x, y: object.y, w: object.w, h: object.h },
        source,
        movable: editable,
        resizable: editable,
      };
    });
  const point = (
    kind: "insertion" | "botSpawn",
    id: string,
    position: Vec2,
    source: { kind: "authored" | "composed"; file: string; note?: string } | undefined,
  ): Handle => ({
    kind,
    building: "outdoor",
    floor: "outdoor",
    id,
    rect: {
      x: position.x - POINT_HANDLE,
      y: position.y - POINT_HANDLE,
      w: POINT_HANDLE * 2,
      h: POINT_HANDLE * 2,
    },
    source: source ?? null,
    movable: false,
    resizable: false,
  });
  return [
    ...objects,
    ...map.extractionPoints
      .filter((entry) => intersects(entry.rect, area))
      .map((entry): Handle => ({
        kind: "extraction",
        building: "outdoor",
        floor: "outdoor",
        id: entry.id,
        rect: entry.rect,
        source: entry.source ?? null,
        movable: false,
        resizable: false,
      })),
    ...map.insertionPoints
      .filter((entry) => intersects({ x: entry.position.x, y: entry.position.y, w: 0, h: 0 }, area))
      .map((entry) => point("insertion", entry.id, entry.position, entry.source)),
    ...map.botSpawns
      .filter((entry) => (entry.floorId ?? "outdoor") === "outdoor"
        && intersects({ x: entry.position.x, y: entry.position.y, w: 0, h: 0 }, area))
      .map((entry) => point("botSpawn", entry.id, entry.position, entry.source)),
  ];
}

function contains(rect: Rect, point: Vec2): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h;
}

/**
 * The smallest handle under the cursor.
 *
 * Smallest rather than topmost, because the thing an author reaches for is
 * usually the small object sitting on the big one — a Dot on a rug, a monitor on
 * a desk — and picking by paint order would always hand back the rug.
 */
export function pick(handles: readonly Handle[], point: Vec2): Handle | null {
  let best: Handle | null = null;
  let bestArea = Infinity;
  for (const handle of handles) {
    if (!contains(handle.rect, point)) continue;
    const area = handle.rect.w * handle.rect.h;
    if (area < bestArea) {
      bestArea = area;
      best = handle;
    }
  }
  return best;
}

export function findObject(source: SourceBuilding, floor: string, id: string): SourceObject | null {
  return source.floors.find((f) => f.label === floor)?.objects?.find((o) => o.id === id) ?? null;
}

export function findDot(source: SourceBuilding, floor: string, id: string): SourceDot | null {
  return source.floors.find((f) => f.label === floor)?.dots?.find((d) => d.id === id) ?? null;
}

export function findWall(source: SourceBuilding, floor: string, id: string): SourceWall | null {
  return source.floors.find((f) => f.label === floor)?.walls?.find((w) => w.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/**
 * A readable, unique id in the house style: `<building>-<kind>-<letter>`.
 *
 * Ids are authored and meaningful in map source rather than sequential, so a new
 * object gets a name a person would have chosen, and never one already taken.
 */
export function nextId(source: SourceBuilding, kind: string): string {
  const taken = new Set<string>();
  for (const floor of source.floors) {
    for (const object of floor.objects ?? []) taken.add(object.id);
    for (const dot of floor.dots ?? []) taken.add(dot.id);
    for (const wall of floor.walls ?? []) taken.add(wall.id);
  }
  const stem = `${source.id}-${kind.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
  for (let index = 0; index < 260; index += 1) {
    const suffix = index < 26
      ? String.fromCharCode(97 + index)
      : `${String.fromCharCode(97 + Math.floor(index / 26) - 1)}${String.fromCharCode(97 + (index % 26))}`;
    const candidate = `${stem}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`Cannot name another ${kind} in ${source.id}`);
}

/** Sensible starting footprint per object kind, in world units. */
export const KIND_SIZE: Partial<Record<ObjectKind, { w: number; h: number }>> = {
  shelf: { w: 26, h: 220 },
  crateStack: { w: 34, h: 34 },
  pallet: { w: 48, h: 36 },
  drum: { w: 24, h: 24 },
  workbench: { w: 112, h: 34 },
  toolCabinet: { w: 44, h: 26 },
  locker: { w: 26, h: 38 },
  desk: { w: 90, h: 44 },
  filingCabinet: { w: 28, h: 44 },
  table: { w: 48, h: 48 },
  chair: { w: 20, h: 20 },
  counter: { w: 110, h: 24 },
  couch: { w: 110, h: 40 },
  bed: { w: 48, h: 92 },
  plant: { w: 20, h: 20 },
  column: { w: 16, h: 16 },
  generator: { w: 72, h: 52 },
  hvac: { w: 70, h: 50 },
  serverRack: { w: 26, h: 56 },
  utilityBox: { w: 40, h: 22 },
  vent: { w: 22, h: 22 },
  rug: { w: 200, h: 140 },
  skylight: { w: 90, h: 56 },
  planter: { w: 36, h: 110 },
  sink: { w: 24, h: 16 },
  toilet: { w: 26, h: 34 },
  fridge: { w: 34, h: 34 },
  stove: { w: 44, h: 26 },
  washer: { w: 36, h: 36 },
  medicalCart: { w: 30, h: 22 },
  conferenceTable: { w: 110, h: 60 },
  receptionDesk: { w: 140, h: 26 },
  forklift: { w: 44, h: 96 },
};

/** The tray, grouped so it reads as a kit rather than an alphabet. */
export const OBJECT_TRAY: Array<{ group: string; kinds: ObjectKind[] }> = [
  { group: "Storage", kinds: ["shelf", "crateStack", "pallet", "drum", "locker", "filingCabinet"] },
  { group: "Work", kinds: ["workbench", "toolCabinet", "desk", "counter", "conferenceTable", "receptionDesk", "serverRack"] },
  { group: "Living", kinds: ["table", "chair", "couch", "bed", "rug", "plant"] },
  { group: "Plant", kinds: ["generator", "hvac", "utilityBox", "vent", "column", "skylight"] },
  { group: "Fit-out", kinds: ["sink", "toilet", "fridge", "stove", "washer", "medicalCart", "planter", "forklift"] },
];

export const DOT_TRAY = [
  { label: "Health", item: { kind: "powerup", type: "health" } },
  { label: "Dash", item: { kind: "powerup", type: "dashOvercharge" } },
  { label: "Radar", item: { kind: "powerup", type: "radar" } },
  { label: "Incognito", item: { kind: "powerup", type: "incognito" } },
] as const;

export const OPENING_TRAY: Array<{ label: string; opening: Omit<SourceOpening, "near"> }> = [
  { label: "Door", opening: { kind: "door", width: 56 } },
  { label: "Double door", opening: { kind: "door", width: 88 } },
  { label: "Roll-up", opening: { kind: "rollup", width: 120 } },
  { label: "Archway", opening: { kind: "archway", width: 96 } },
  { label: "Window", opening: { kind: "window", width: 44 } },
];
