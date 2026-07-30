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

type ObjectExtra = Partial<MapObject>;
type MakeObject = (
  kind: ObjectKind,
  x: number,
  y: number,
  w: number,
  h: number,
  extra?: ObjectExtra,
) => MapObject;
type MakeAuthoredObject = (
  key: string,
  kind: ObjectKind,
  x: number,
  y: number,
  w: number,
  h: number,
  extra?: ObjectExtra,
) => MapObject;

export type OutdoorObjectFactory = MakeObject & {
  /** A direct source literal with an authored, stable, meaningful key. */
  authored: MakeAuthoredObject;
  /**
   * Evaluate one placing rule while tagging every object it emits as derived.
   *
   * The callback form is load-bearing: tagging an array after `.map()` returns
   * would let the factory briefly describe its members as direct source literals.
   */
  derived(rule: OutdoorRule, build: () => MapObject[]): MapObject[];
};

function stableToken(value: string | number): string {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function outdoorCallFingerprint(key: string, kind: ObjectKind): string {
  return `${key}:${kind}`;
}

/**
 * Outdoor object authoring with stable runtime IDs and explicit source ownership.
 *
 * Direct objects require a literal authored key. Rule output derives its ID from
 * the rule id plus a geometry-based member key, so iteration order is irrelevant.
 */
export function objects(prefix: string, file: string): OutdoorObjectFactory {
  let activeRule: OutdoorRule | null = null;
  const authoredKeys = new Set<string>();
  let derivedKeys = new Set<string>();

  const makeAuthored: MakeAuthoredObject = (
    key,
    kind,
    x,
    y,
    w,
    h,
    extra = {},
  ) => {
    if (activeRule) throw new Error(`Use the rule member form inside ${activeRule.id}, not obj.authored(...).`);
    if (!key || authoredKeys.has(key)) throw new Error(`Duplicate outdoor authored key "${key}" in ${file}.`);
    authoredKeys.add(key);
    const fingerprint = outdoorCallFingerprint(key, kind);
    const source: OutdoorSource = {
      kind: "authored",
      file,
      key,
      objectKind: kind,
      fingerprint,
      call: "obj",
    };
    return {
      id: `${stableToken(prefix)}-${stableToken(key)}`,
      kind,
      x,
      y,
      w,
      h,
      ...extra,
      source,
    };
  };

  const object = ((
    kind: ObjectKind,
    x: number,
    y: number,
    w: number,
    h: number,
    extra: ObjectExtra = {},
  ): MapObject => {
    if (!activeRule) {
      throw new Error(`Direct outdoor objects in ${file} require obj.authored("meaningful-key", ...).`);
    }
    const memberKey = [
      stableToken(kind),
      stableToken(x),
      stableToken(y),
      `${stableToken(w)}x${stableToken(h)}`,
    ].join("-");
    if (derivedKeys.has(memberKey)) {
      throw new Error(`Rule ${activeRule.id} emits duplicate member ${memberKey}.`);
    }
    derivedKeys.add(memberKey);
    return {
      id: `${stableToken(prefix)}-${stableToken(activeRule.id)}-${memberKey}`,
      kind,
      x,
      y,
      w,
      h,
      ...extra,
      source: { kind: "derived", file, rule: activeRule, memberKey },
    };
  }) as OutdoorObjectFactory;

  object.authored = makeAuthored;
  object.derived = (rule, build) => {
    if (activeRule) throw new Error(`Outdoor placing rules cannot nest (${activeRule.id} -> ${rule.id}).`);
    activeRule = rule;
    derivedKeys = new Set();
    try {
      return build();
    } finally {
      activeRule = null;
      derivedKeys = new Set();
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
  throw new OutdoorPatchError("Unterminated string or template in outdoor source");
}

function skipComment(text: string, start: number): number {
  if (text[start + 1] === "/") {
    const end = text.indexOf("\n", start + 2);
    return end < 0 ? text.length - 1 : end;
  }
  const end = text.indexOf("*/", start + 2);
  if (end < 0) throw new OutdoorPatchError("Unterminated comment in outdoor source");
  return end + 1;
}

/** Match (), [] or {}, respecting line/block comments, strings and templates. */
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
    if (char === "/" && (text[at + 1] === "/" || text[at + 1] === "*")) {
      at = skipComment(text, at);
      continue;
    }
    if (char === opener) depth += 1;
    else if (char === closer && --depth === 0) return at;
  }
  throw new OutdoorPatchError(`Unbalanced ${opener} at ${open}`);
}

function trimSpan(text: string, span: Span): Span {
  let { start, end } = span;
  while (start < end && /\s/.test(text[start])) start += 1;
  while (end > start && /\s/.test(text[end - 1])) end -= 1;
  return { start, end };
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
    if (char === "/" && (text[at + 1] === "/" || text[at + 1] === "*")) {
      at = skipComment(text, at);
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

function stringLiteral(text: string, span: Span): string | null {
  const raw = text.slice(span.start, span.end);
  if (raw.length < 2 || !["'", '"'].includes(raw[0]) || raw.at(-1) !== raw[0]) return null;
  const body = raw.slice(1, -1);
  return body.replace(/\\(['"\\])/g, "$1");
}

/**
 * Find only real `obj(...)` expressions in executable source.
 *
 * This scanner advances over comments, strings and entire templates before it
 * considers an identifier, so a documentation example cannot become a patch target.
 */
function objectCallSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (char === '"' || char === "'" || char === "`") {
      at = skipString(text, at);
      continue;
    }
    if (char === "/" && (text[at + 1] === "/" || text[at + 1] === "*")) {
      at = skipComment(text, at);
      continue;
    }
    if (!text.startsWith("obj", at)
      || /[A-Za-z0-9_$]/.test(text[at - 1] ?? "")
      || /[A-Za-z0-9_$]/.test(text[at + 3] ?? "")) continue;
    let open = at + 3;
    while (/\s/.test(text[open] ?? "")) open += 1;
    if (text.startsWith(".authored", open)) {
      open += ".authored".length;
      while (/\s/.test(text[open] ?? "")) open += 1;
    }
    if (text[open] !== "(") continue;
    spans.push({ start: at, end: matchBracket(text, open) + 1 });
    at = spans.at(-1)!.end - 1;
  }
  return spans;
}

type DirectObjectCall = {
  call: Span;
  args: Span[];
  key: string;
  objectKind: ObjectKind;
  fingerprint: string;
};

function directObjectCalls(text: string): DirectObjectCall[] {
  const calls: DirectObjectCall[] = [];
  for (const call of objectCallSpans(text)) {
    const args = argumentsOf(text, call);
    if (args.length < 6) continue;
    const key = stringLiteral(text, args[0]);
    const objectKind = stringLiteral(text, args[1]) as ObjectKind | null;
    if (!key || !objectKind) continue;
    calls.push({
      call,
      args,
      key,
      objectKind,
      fingerprint: outdoorCallFingerprint(key, objectKind),
    });
  }
  return calls;
}

function replaceArguments(
  text: string,
  direct: DirectObjectCall,
  replacements: Map<number, number>,
): string {
  let next = text;
  for (const [index, value] of [...replacements].sort((a, b) => b[0] - a[0])) {
    const span = direct.args[index];
    if (!span) throw new OutdoorPatchError(`Outdoor obj(...) has no argument ${index}.`);
    next = next.slice(0, span.start) + String(value) + next.slice(span.end);
  }
  return next;
}

/** Patch one stable authored outdoor call. Rule-derived output never reaches this path. */
export function applyOutdoorEdit(text: string, edit: OutdoorSourceEdit): string {
  if (!edit.source || edit.source.kind !== "authored") {
    throw new OutdoorPatchError(
      `${edit.id} is a computed runtime id with no authored source locator; refusing to patch it.`,
    );
  }
  const expected = outdoorCallFingerprint(edit.source.key, edit.source.objectKind);
  if (edit.source.fingerprint !== expected) {
    throw new OutdoorPatchError(
      `${edit.id} has an invalid authored fingerprint ${edit.source.fingerprint}; expected ${expected}.`,
    );
  }
  const calls = directObjectCalls(text);
  const direct = calls.find((candidate) => candidate.fingerprint === expected);
  if (!direct) {
    const sameKey = calls.find((candidate) => candidate.key === edit.source.key);
    const detail = sameKey
      ? `kind is ${sameKey.objectKind}, not ${edit.source.objectKind}`
      : "stable call was not found";
    throw new OutdoorPatchError(
      `Could not verify authored locator ${expected} in ${edit.source.file}: ${detail}. Reload Studio before saving.`,
    );
  }
  if (calls.filter((candidate) => candidate.fingerprint === expected).length !== 1) {
    throw new OutdoorPatchError(`Authored locator ${expected} is duplicated in ${edit.source.file}.`);
  }
  return edit.op === "moveOutdoorObject"
    ? replaceArguments(text, direct, new Map([[2, edit.x], [3, edit.y]]))
    : replaceArguments(text, direct, new Map([[4, edit.w], [5, edit.h]]));
}

export function applyOutdoorEdits(text: string, edits: readonly OutdoorSourceEdit[]): string {
  return edits.reduce(applyOutdoorEdit, text);
}
