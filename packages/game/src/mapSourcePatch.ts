import type { SourceDot, SourceObject, SourceOpening, SourceStair, SourceWall } from "./mapSource";

/**
 * Surgical edits to an authored map-source file.
 *
 * The editor has to write back into the same file a person and an LLM read, and
 * those files are not data dumps — they carry comments explaining why a bench
 * faces the way it does, shared helpers like `wcFixtures("f3")`, and named
 * constants like `UP_DOOR`. Re-serialising a `SourceBuilding` would produce a
 * correct file and destroy every one of those, which would quietly make the
 * authoring workflow worse each time the editor was used.
 *
 * So an edit is a patch, not a rewrite: find the one literal it names, change
 * the fields it names, leave every byte around it alone. Anything the editor
 * cannot locate that way — an object produced by a helper call rather than
 * written out — is reported rather than guessed at, so the answer is "edit this
 * in the source" instead of a silent no-op.
 */

export type SourceEdit =
  | { op: "moveObject"; floor: string; id: string; x: number; y: number }
  | { op: "moveDot"; floor: string; id: string; x: number; y: number }
  | { op: "deleteObject"; floor: string; id: string }
  | { op: "deleteDot"; floor: string; id: string }
  | { op: "addObject"; floor: string; object: SourceObject }
  | { op: "addDot"; floor: string; dot: SourceDot }
  | { op: "addWall"; floor: string; wall: SourceWall }
  | { op: "addOpening"; floor: string; wall: string; opening: SourceOpening }
  | { op: "addStair"; stair: SourceStair };

export class PatchError extends Error {}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

const BARE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * A value as the TypeScript literal an author would have written: bare keys,
 * double quotes, no trailing commas, everything on one line.
 *
 * One line per entity is deliberate. It is what makes the whole file diffable
 * and what lets a later edit find and rewrite a single object without a parser.
 */
export function printLiteral(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(printLiteral).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    if (!entries.length) return "{}";
    const body = entries
      .map(([key, item]) => `${BARE_KEY.test(key) ? key : JSON.stringify(key)}: ${printLiteral(item)}`)
      .join(", ");
    return `{ ${body} }`;
  }
  throw new PatchError(`Cannot print ${typeof value} into map source`);
}

// ---------------------------------------------------------------------------
// Locating
// ---------------------------------------------------------------------------

/** Index of the bracket matching the one at `open`, respecting nesting and strings. */
function matchBracket(text: string, open: number): number {
  const opener = text[open];
  const closer = opener === "[" ? "]" : opener === "{" ? "}" : "";
  if (!closer) throw new PatchError(`Not a bracket at ${open}`);
  let depth = 0;
  for (let at = open; at < text.length; at += 1) {
    const char = text[at];
    if (char === '"' || char === "'" || char === "`") {
      at = skipString(text, at);
      continue;
    }
    if (char === "/" && text[at + 1] === "/") {
      at = text.indexOf("\n", at);
      if (at < 0) break;
      continue;
    }
    if (char === "/" && text[at + 1] === "*") {
      at = text.indexOf("*/", at) + 1;
      continue;
    }
    if (char === opener) depth += 1;
    else if (char === closer) {
      depth -= 1;
      if (depth === 0) return at;
    }
  }
  throw new PatchError(`Unbalanced ${opener} at ${open}`);
}

function skipString(text: string, start: number): number {
  const quote = text[start];
  for (let at = start + 1; at < text.length; at += 1) {
    if (text[at] === "\\") {
      at += 1;
      continue;
    }
    if (text[at] === quote) return at;
  }
  throw new PatchError("Unterminated string in map source");
}

type Span = { start: number; end: number };

/** The `[...]` of `<name>: [` inside the given floor, as a span of its contents. */
function arraySpan(text: string, floor: string, name: string): Span {
  const label = text.indexOf(`label: ${JSON.stringify(floor)}`);
  if (label < 0) throw new PatchError(`No floor labelled ${floor} in this file`);
  // The floor's own object literal bounds the search, so a later floor's
  // `objects: [` can never be mistaken for this one's.
  const floorOpen = text.lastIndexOf("{", label);
  const floorClose = matchBracket(text, floorOpen);
  const key = text.indexOf(`${name}: [`, label);
  if (key < 0 || key > floorClose) throw new PatchError(`Floor ${floor} has no ${name} array`);
  const open = text.indexOf("[", key);
  return { start: open + 1, end: matchBracket(text, open) };
}

/** The object literal carrying `id: "<id>"` inside a span. */
function entrySpan(text: string, within: Span, id: string): Span {
  const needle = `id: ${JSON.stringify(id)}`;
  const at = text.indexOf(needle, within.start);
  if (at < 0 || at > within.end) {
    throw new PatchError(`${id} is not written out in this file — it is produced by a helper, so edit the source directly`);
  }
  const open = text.lastIndexOf("{", at);
  return { start: open, end: matchBracket(text, open) + 1 };
}

/** Indentation of the line `at` sits on. */
function indentAt(text: string, at: number): string {
  const lineStart = text.lastIndexOf("\n", at) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))![0];
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

function setNumber(literal: string, key: string, value: number): string {
  const pattern = new RegExp(`(\\b${key}:\\s*)-?[0-9.]+`);
  if (!pattern.test(literal)) throw new PatchError(`No ${key} to move in ${literal.slice(0, 60)}`);
  return literal.replace(pattern, `$1${printLiteral(value)}`);
}

function moveEntry(text: string, span: Span, x: number, y: number): string {
  const moved = setNumber(setNumber(text.slice(span.start, span.end), "x", x), "y", y);
  return text.slice(0, span.start) + moved + text.slice(span.end);
}

/** Remove an entry along with its trailing comma and its now-empty line. */
function deleteEntry(text: string, span: Span): string {
  let end = span.end;
  if (text[end] === ",") end += 1;
  // Take any trailing same-line comment and the newline with it.
  const lineEnd = text.indexOf("\n", end);
  if (lineEnd >= 0 && text.slice(end, lineEnd).trim() === "") end = lineEnd + 1;
  const lineStart = text.lastIndexOf("\n", span.start) + 1;
  const start = text.slice(lineStart, span.start).trim() === "" ? lineStart : span.start;
  return text.slice(0, start) + text.slice(end);
}

/** Append a literal as the last entry of an array, matching its indentation. */
function appendEntry(text: string, span: Span, literal: string): string {
  const content = text.slice(span.start, span.end);
  const trimmed = content.replace(/\s+$/, "");
  const comma = trimmed.endsWith(",") || trimmed === "" ? "" : ",";

  // An array written on one line stays on one line.
  if (!content.includes("\n")) {
    const inline = trimmed === "" ? literal : `${trimmed}${comma} ${literal}`;
    return text.slice(0, span.start) + inline + text.slice(span.end);
  }

  const closeIndent = /\n([ \t]*)$/.exec(content)?.[1] ?? indentAt(text, span.start);
  if (trimmed === "") {
    return `${text.slice(0, span.start)}\n${closeIndent}  ${literal},\n${closeIndent}${text.slice(span.end)}`;
  }
  const entryIndent = /\n([ \t]*)[^\n]*$/.exec(trimmed)?.[1] ?? `${closeIndent}  `;
  return `${text.slice(0, span.start)}${trimmed}${comma}\n${entryIndent}${literal},\n${closeIndent}${text.slice(span.end)}`;
}

/** Apply one edit to a map-source file's text. */
export function applyEdit(text: string, edit: SourceEdit): string {
  switch (edit.op) {
    case "moveObject":
      return moveEntry(text, entrySpan(text, arraySpan(text, edit.floor, "objects"), edit.id), edit.x, edit.y);
    case "moveDot":
      return moveEntry(text, entrySpan(text, arraySpan(text, edit.floor, "dots"), edit.id), edit.x, edit.y);
    case "deleteObject":
      return deleteEntry(text, entrySpan(text, arraySpan(text, edit.floor, "objects"), edit.id));
    case "deleteDot":
      return deleteEntry(text, entrySpan(text, arraySpan(text, edit.floor, "dots"), edit.id));
    case "addObject":
      return appendEntry(text, arraySpan(text, edit.floor, "objects"), printLiteral(edit.object));
    case "addDot":
      return appendEntry(text, arraySpan(text, edit.floor, "dots"), printLiteral(edit.dot));
    case "addWall":
      return appendEntry(text, arraySpan(text, edit.floor, "walls"), printLiteral(edit.wall));
    case "addOpening": {
      const wall = entrySpan(text, arraySpan(text, edit.floor, "walls"), edit.wall);
      const key = text.indexOf("openings: [", wall.start);
      if (key < 0 || key > wall.end) {
        // The wall has no openings yet; give it one, before its closing brace.
        const indent = `${indentAt(text, wall.start)}  `;
        const close = wall.end - 1;
        const before = text.slice(0, close).replace(/\s+$/, "");
        const comma = before.endsWith(",") ? "" : ",";
        return `${before}${comma}\n${indent}openings: [${printLiteral(edit.opening)}],\n${indentAt(text, wall.start)}${text.slice(close)}`;
      }
      const open = text.indexOf("[", key);
      return appendEntry(text, { start: open + 1, end: matchBracket(text, open) }, printLiteral(edit.opening));
    }
    case "addStair": {
      const key = text.indexOf("stairs: [");
      if (key < 0) throw new PatchError("This building has no stairs array");
      const open = text.indexOf("[", key);
      return appendEntry(text, { start: open + 1, end: matchBracket(text, open) }, printLiteral(edit.stair));
    }
    default: {
      const never: never = edit;
      throw new PatchError(`Unknown edit ${JSON.stringify(never)}`);
    }
  }
}

export function applyEdits(text: string, edits: readonly SourceEdit[]): string {
  return edits.reduce(applyEdit, text);
}
