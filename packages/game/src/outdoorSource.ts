import type {
  MapObject,
  ObjectKind,
  OutdoorRule,
  OutdoorSource,
} from "./types";

export type { OutdoorRule, OutdoorSource } from "./types";

export type OutdoorSourceEdit =
  | {
    op: "moveOutdoorObject";
    id: string;
    source: Extract<OutdoorSource, { kind: "authored" }>;
    x: number;
    y: number;
  }
  | {
    op: "resizeOutdoorObject";
    id: string;
    source: Extract<OutdoorSource, { kind: "authored" }>;
    w: number;
    h: number;
  };

export type OutdoorObjectFactory = {
  (
    kind: ObjectKind,
    x: number,
    y: number,
    w: number,
    h: number,
    extra?: Partial<MapObject>,
  ): MapObject;
  /**
   * Evaluate one placing rule while tagging every object it emits as derived.
   *
   * The callback form is load-bearing: tagging an array after `.map()` returns
   * would let the factory briefly describe its members as direct source literals.
   */
  derived(rule: OutdoorRule, build: () => MapObject[]): MapObject[];
};

/**
 * Outdoor object authoring with stable runtime IDs and explicit source ownership.
 *
 * `prefix` may be a function for old maps whose public IDs have a historic shape.
 * Source ordinals count only direct calls, so expanding a rhythm never renumbers
 * the patch locator of the literal object below it.
 */
export function objects(
  prefix: string | (() => string),
  file: string,
): OutdoorObjectFactory {
  let sequence = 0;
  let authoredOrdinal = 0;
  let activeRule: OutdoorRule | null = null;
  const nextId = typeof prefix === "function"
    ? prefix
    : () => `${prefix}-o${sequence++}`;

  const object = ((
    kind: ObjectKind,
    x: number,
    y: number,
    w: number,
    h: number,
    extra: Partial<MapObject> = {},
  ): MapObject => {
    const source: OutdoorSource = activeRule
      ? { kind: "derived", file, rule: activeRule }
      : { kind: "authored", file, ordinal: authoredOrdinal++, call: "obj" };
    return { id: nextId(), kind, x, y, w, h, ...extra, source };
  }) as OutdoorObjectFactory;

  object.derived = (rule, build) => {
    if (activeRule) throw new Error(`Outdoor placing rules cannot nest (${activeRule.id} -> ${rule.id}).`);
    activeRule = rule;
    try {
      return build();
    } finally {
      activeRule = null;
    }
  };
  return object;
}

export function outdoorSourceOf(object: MapObject): OutdoorSource | null {
  return object.source ?? null;
}

/** Concise source metadata for the repeated placements used by region files. */
export function rhythmRule(
  id: string,
  label: string,
  axis: "x" | "y",
  expression: string,
  from: number,
  to: number,
  spacing: number,
  gaps: Array<[number, number]> = [],
): OutdoorRule {
  return {
    id,
    label,
    axis,
    expression,
    from,
    to,
    spacing,
    gaps,
    parameters: [
      { name: "from", source: expression, value: String(from) },
      { name: "to", source: expression, value: String(to) },
      { name: "spacing", source: expression, value: String(spacing) },
      { name: "gaps", source: expression, value: JSON.stringify(gaps) },
    ],
  };
}

export class OutdoorPatchError extends Error {}

type Span = { start: number; end: number };

function skipString(text: string, start: number): number {
  const quote = text[start];
  for (let at = start + 1; at < text.length; at += 1) {
    if (text[at] === "\\") {
      at += 1;
      continue;
    }
    if (text[at] === quote) return at;
  }
  throw new OutdoorPatchError("Unterminated string in outdoor source");
}

/** Match (), [] or {}, respecting strings and comments. */
function matchBracket(text: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const opener = text[open];
  const closer = pairs[opener];
  if (!closer) throw new OutdoorPatchError(`Not a bracket at ${open}`);
  let depth = 0;
  for (let at = open; at < text.length; at += 1) {
    const char = text[at];
    if (char === '"' || char === "'" || char === "`") {
      at = skipString(text, at);
      continue;
    }
    if (char === "/" && text[at + 1] === "/") {
      const end = text.indexOf("\n", at);
      if (end < 0) break;
      at = end;
      continue;
    }
    if (char === "/" && text[at + 1] === "*") {
      const end = text.indexOf("*/", at + 2);
      if (end < 0) throw new OutdoorPatchError("Unterminated comment in outdoor source");
      at = end + 1;
      continue;
    }
    if (char === opener) depth += 1;
    else if (char === closer && --depth === 0) return at;
  }
  throw new OutdoorPatchError(`Unbalanced ${opener} at ${open}`);
}

function callSpans(text: string, pattern: RegExp): Span[] {
  const spans: Span[] = [];
  for (const match of text.matchAll(pattern)) {
    const open = text.indexOf("(", match.index);
    spans.push({ start: match.index, end: matchBracket(text, open) + 1 });
  }
  return spans;
}

/** Top-level argument spans, excluding their surrounding whitespace. */
function argumentsOf(text: string, call: Span): Span[] {
  const open = text.indexOf("(", call.start);
  const close = call.end - 1;
  const spans: Span[] = [];
  let start = open + 1;
  const stack: string[] = [];
  for (let at = start; at < close; at += 1) {
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
      at = text.indexOf("*/", at + 2) + 1;
      continue;
    }
    if ("([{".includes(char)) stack.push(char);
    else if (")]}".includes(char)) stack.pop();
    else if (char === "," && stack.length === 0) {
      spans.push(trimSpan(text, { start, end: at }));
      start = at + 1;
    }
  }
  spans.push(trimSpan(text, { start, end: close }));
  return spans;
}

function trimSpan(text: string, span: Span): Span {
  let { start, end } = span;
  while (start < end && /\s/.test(text[start])) start += 1;
  while (end > start && /\s/.test(text[end - 1])) end -= 1;
  return { start, end };
}

function directObjectCalls(text: string): Span[] {
  const derived = callSpans(text, /\bobj\.derived\s*\(/g);
  return callSpans(text, /\bobj\s*\(/g)
    .filter((call) => !derived.some((rule) => call.start > rule.start && call.end < rule.end));
}

function replaceArguments(text: string, call: Span, replacements: Map<number, number>): string {
  const args = argumentsOf(text, call);
  if (args.length < 5) throw new OutdoorPatchError("Outdoor obj(...) call has fewer than five geometry arguments.");
  let next = text;
  for (const [index, value] of [...replacements].sort((a, b) => b[0] - a[0])) {
    const span = args[index];
    if (!span) throw new OutdoorPatchError(`Outdoor obj(...) has no argument ${index}.`);
    next = next.slice(0, span.start) + String(value) + next.slice(span.end);
  }
  return next;
}

/**
 * Patch one direct outdoor object call. Derived output never reaches this path.
 *
 * Runtime IDs are deliberately not searched in the file: `fair-o17` is produced
 * by a sequence counter and is not a source anchor. The authored-call locator is.
 */
export function applyOutdoorEdit(text: string, edit: OutdoorSourceEdit): string {
  if (!edit.source || edit.source.kind !== "authored") {
    throw new OutdoorPatchError(
      `${edit.id} is a computed runtime id with no authored source locator; refusing to patch it.`,
    );
  }
  const call = directObjectCalls(text)[edit.source.ordinal];
  if (!call) {
    throw new OutdoorPatchError(
      `Could not find authored object ${edit.source.ordinal} in ${edit.source.file}; reload Studio before saving.`,
    );
  }
  return edit.op === "moveOutdoorObject"
    ? replaceArguments(text, call, new Map([[1, edit.x], [2, edit.y]]))
    : replaceArguments(text, call, new Map([[3, edit.w], [4, edit.h]]));
}

export function applyOutdoorEdits(text: string, edits: readonly OutdoorSourceEdit[]): string {
  return edits.reduce(applyOutdoorEdit, text);
}
