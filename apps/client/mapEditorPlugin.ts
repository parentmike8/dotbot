import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { MapDocument } from "@dotbot/game/types";
// Vite executes this plugin while loading its config. Keep the validator a
// relative source import so it is bundled with the config instead of being
// externalized as a workspace package that plain Node cannot load as TS.
import { validateEditableMap } from "../../packages/game/src/mapEditor";
import type { Plugin } from "vite";

type AssetIndexEntry = {
  id: string;
  name: string;
  relativePath: string;
  pack: string;
  category: string;
  resolution: number | null;
  width: number;
  height: number;
  defaultW: number;
  defaultH: number;
};

type RuntimeAsset = {
  key: string;
  url: string;
  name: string;
  source: string;
  width: number;
  height: number;
  defaultW: number;
  defaultH: number;
  collision: { x: number; y: number; w: number; h: number };
  occlusionY: number;
};

type RuntimeManifest = {
  version: 1;
  assets: Record<string, RuntimeAsset>;
};

const MAP_FILES: Record<string, string> = {
  "pixel-city": "packages/game/src/content/authored/pixel-city.json",
};

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const PAGE_SIZE = 60;

function json(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(value));
}

async function requestBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request is too large.");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function safeWithin(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root) + sep;
  return resolve(candidate).startsWith(normalizedRoot);
}

function pngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24 || buffer.toString("hex", 0, 8) !== "89504e470d0a1a0a") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** Decode the alpha plane of the packs' common 8-bit RGBA PNG format. This
 * runs only when an asset is promoted, never while indexing the tray. */
function pngAlphaBounds(buffer: Buffer): { x: number; y: number; w: number; h: number } | null {
  const dimensions = pngDimensions(buffer);
  if (!dimensions || buffer[24] !== 8 || buffer[25] !== 6 || buffer[28] !== 0) return null;
  const chunks: Buffer[] = [];
  for (let offset = 8; offset + 12 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") chunks.push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
    if (type === "IEND") break;
  }
  if (!chunks.length) return null;
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = dimensions.width * 4;
  const rows: Buffer[] = [];
  let cursor = 0;
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < dimensions.height; y += 1) {
    const filter = raw[cursor++];
    const source = raw.subarray(cursor, cursor + stride);
    cursor += stride;
    const row = Buffer.alloc(stride);
    const previous = rows[y - 1];
    for (let x = 0; x < stride; x += 1) {
      const left = x >= 4 ? row[x - 4] : 0;
      const up = previous?.[x] ?? 0;
      const upperLeft = x >= 4 ? previous?.[x - 4] ?? 0 : 0;
      const predictor = filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : filter === 4 ? paeth(left, up, upperLeft) : 0;
      row[x] = (source[x] + predictor) & 0xff;
    }
    rows.push(row);
  }
  let minX = dimensions.width, minY = dimensions.height, maxX = -1, maxY = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < dimensions.width; x += 1) if (row[x * 4 + 3] > 16) {
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  });
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function suggestedCollision(name: string, bounds: { x: number; y: number; w: number; h: number }, scale: number) {
  const narrow = /tree|lamp|post|hydrant|sign|plant/i.test(name);
  const broad = /car|truck|bus|bench|sofa|counter|table|cabinet|shelf|rack/i.test(name);
  const widthRatio = narrow ? 0.34 : broad ? 0.82 : 0.64;
  const heightRatio = narrow ? 0.14 : broad ? 0.24 : 0.2;
  const w = Math.max(8, Math.round(bounds.w * scale * widthRatio));
  const h = Math.max(8, Math.round(bounds.h * scale * heightRatio));
  const x = Math.round((bounds.x + bounds.w / 2) * scale - w / 2);
  const y = Math.round((bounds.y + bounds.h) * scale - h);
  return { x, y, w, h };
}

function sourceResolution(relativePath: string): number | null {
  const match = relativePath.match(/(?:^|[_/])(16|32|48)x(?:16|32|48)(?:[_/]|$)/i);
  return match ? Number(match[1]) : null;
}

function defaultWorldSize(width: number, height: number, resolution: number | null): { defaultW: number; defaultH: number } {
  const scale = resolution ? 48 / resolution : 1;
  return { defaultW: Math.max(1, Math.round(width * scale)), defaultH: Math.max(1, Math.round(height * scale)) };
}

async function walkPngs(root: string, directory = root, output: string[] = []): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await walkPngs(root, path, output);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".png")) output.push(path);
  }));
  return output;
}

async function buildAssetIndex(gameAssetsRoot: string): Promise<{ entries: AssetIndexEntry[]; byId: Map<string, AssetIndexEntry> }> {
  const files = await walkPngs(gameAssetsRoot);
  const entries: AssetIndexEntry[] = [];
  // Reading 100k complete PNGs made the first tray search take minutes.
  // Read only the 24-byte PNG header, in bounded parallel batches.
  for (let start = 0; start < files.length; start += 256) {
    const batch = await Promise.all(files.slice(start, start + 256).map(async (path) => {
      const handle = await open(path, "r");
      try {
        const header = Buffer.alloc(24);
        await handle.read(header, 0, 24, 0);
        return { path, dimensions: pngDimensions(header) };
      } finally {
        await handle.close();
      }
    }));
    for (const { path, dimensions } of batch) {
      if (!dimensions) continue;
      const relativePath = path.slice(resolve(gameAssetsRoot).length + 1).split(sep).join("/");
      const id = createHash("sha1").update(relativePath).digest("hex");
      const resolution = sourceResolution(relativePath);
      const size = defaultWorldSize(dimensions.width, dimensions.height, resolution);
      const parts = relativePath.split("/");
      entries.push({
        id,
        name: parts.at(-1)!.replace(/\.png$/i, "").replaceAll("_", " "),
        relativePath,
        pack: parts[0] ?? "Assets",
        category: parts.at(-2)?.replaceAll("_", " ") ?? "Assets",
        resolution,
        width: dimensions.width,
        height: dimensions.height,
        ...size,
      });
    }
  }
  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { entries, byId: new Map(entries.map((entry) => [entry.id, entry])) };
}

async function readManifest(path: string): Promise<RuntimeManifest> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as RuntimeManifest;
  } catch {
    return { version: 1, assets: {} };
  }
}

export function mapEditorPlugin(): Plugin {
  const workspaceRoot = resolve(import.meta.dirname, "../..");
  const gameAssetsRoot = resolve(workspaceRoot, "Game Assets");
  const publicEditorRoot = resolve(workspaceRoot, "apps/client/public/assets/editor");
  const manifestPath = resolve(publicEditorRoot, "manifest.json");
  const historyRoot = resolve(workspaceRoot, ".map-editor-history");
  let assetIndexPromise: ReturnType<typeof buildAssetIndex> | null = null;
  const assetIndex = () => assetIndexPromise ??= buildAssetIndex(gameAssetsRoot);

  const pruneRuntimeAssets = async (map: MapDocument) => {
    const used = new Set([
      ...(map.artPlacements ?? []).map((placement) => placement.assetKey),
      ...map.outdoor.objects.map((object) => object.art?.assetKey).filter((key): key is string => Boolean(key)),
      ...map.buildings.flatMap((building) => building.floors.flatMap((floor) => floor.objects.map((object) => object.art?.assetKey).filter((key): key is string => Boolean(key)))),
    ].filter((key) => key.startsWith("editor-")));
    const manifest = await readManifest(manifestPath);
    let changed = false;
    for (const [key, asset] of Object.entries(manifest.assets)) {
      if (used.has(key)) continue;
      delete manifest.assets[key];
      changed = true;
      const path = resolve(publicEditorRoot, asset.url.split("/").at(-1) ?? "");
      if (safeWithin(publicEditorRoot, path)) await unlink(path).catch(() => undefined);
    }
    if (changed) {
      const temporary = `${manifestPath}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await rename(temporary, manifestPath);
    }
  };

  return {
    name: "dotbot-map-editor",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const requestUrl = new URL(req.url ?? "/", "http://localhost");
        try {
          const mapMatch = requestUrl.pathname.match(/^\/api\/map-editor\/maps\/([^/]+)$/);
          if (mapMatch) {
            const relative = MAP_FILES[mapMatch[1]];
            if (!relative) return json(res, 404, { error: "Unknown editable map." });
            const mapPath = resolve(workspaceRoot, relative);
            if (req.method === "GET") {
              return json(res, 200, JSON.parse(await readFile(mapPath, "utf8")));
            }
            if (req.method === "PUT") {
              const candidate = await requestBody(req);
              const issues = validateEditableMap(candidate);
              const errors = issues.filter((issue) => issue.severity === "error");
              if (errors.length) return json(res, 400, { error: "Map has structural errors.", issues });
              const map = candidate as MapDocument;
              const serialized = `${JSON.stringify(map, null, 2)}\n`;
              await mkdir(historyRoot, { recursive: true });
              await copyFile(mapPath, resolve(historyRoot, `${mapMatch[1]}-${Date.now()}.json`));
              const temporary = `${mapPath}.${process.pid}.tmp`;
              await writeFile(temporary, serialized, "utf8");
              await rename(temporary, mapPath);
              await pruneRuntimeAssets(map);
              return json(res, 200, {
                saved: true,
                revision: createHash("sha1").update(serialized).digest("hex").slice(0, 12),
                issues,
              });
            }
            return json(res, 405, { error: "Method not allowed." });
          }

          if (requestUrl.pathname === "/api/map-editor/assets" && req.method === "GET") {
            const { entries } = await assetIndex();
            const query = (requestUrl.searchParams.get("q") ?? "").trim().toLowerCase();
            const pack = requestUrl.searchParams.get("pack") ?? "";
            const singles = requestUrl.searchParams.get("singles") !== "0";
            const resolution = Number(requestUrl.searchParams.get("resolution") ?? 48);
            const page = Math.max(0, Number(requestUrl.searchParams.get("page") ?? 0) || 0);
            const filtered = entries.filter((entry) =>
              (!query || `${entry.name} ${entry.relativePath}`.toLowerCase().includes(query)) &&
              (!pack || entry.pack === pack) &&
              (!singles || /(?:single|complete_singles|singles_shadowless)/i.test(entry.relativePath)) &&
              (!resolution || entry.resolution === resolution),
            );
            const packs = [...new Set(entries.map((entry) => entry.pack))].sort();
            return json(res, 200, {
              total: filtered.length,
              page,
              pageSize: PAGE_SIZE,
              packs,
              assets: filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
            });
          }

          const previewMatch = requestUrl.pathname.match(/^\/api\/map-editor\/assets\/([a-f0-9]{40})\/image$/);
          if (previewMatch && req.method === "GET") {
            const { byId } = await assetIndex();
            const entry = byId.get(previewMatch[1]);
            if (!entry) return json(res, 404, { error: "Unknown asset." });
            const path = resolve(gameAssetsRoot, entry.relativePath);
            if (!safeWithin(gameAssetsRoot, path)) return json(res, 400, { error: "Invalid asset path." });
            const info = await stat(path);
            res.statusCode = 200;
            res.setHeader("content-type", "image/png");
            res.setHeader("content-length", info.size);
            res.setHeader("cache-control", "private, max-age=3600");
            res.end(await readFile(path));
            return;
          }

          if (requestUrl.pathname === "/api/map-editor/assets/promote" && req.method === "POST") {
            const body = await requestBody(req) as { id?: unknown };
            const { byId } = await assetIndex();
            const entry = typeof body.id === "string" ? byId.get(body.id) : undefined;
            if (!entry) return json(res, 404, { error: "Unknown asset." });
            const key = `editor-${entry.id.slice(0, 16)}`;
            const filename = `${key}.png`;
            const source = resolve(gameAssetsRoot, entry.relativePath);
            const destination = resolve(publicEditorRoot, filename);
            await mkdir(publicEditorRoot, { recursive: true });
            await copyFile(source, destination);
            const sourceBuffer = await readFile(source);
            const opaque = pngAlphaBounds(sourceBuffer) ?? { x: 0, y: 0, w: entry.width, h: entry.height };
            const worldScale = entry.resolution ? 48 / entry.resolution : 1;
            const collision = suggestedCollision(entry.name, opaque, worldScale);
            const manifest = await readManifest(manifestPath);
            const promoted: RuntimeAsset = {
              key,
              url: `/assets/editor/${filename}`,
              name: entry.name,
              source: entry.relativePath,
              width: entry.width,
              height: entry.height,
              defaultW: entry.defaultW,
              defaultH: entry.defaultH,
              collision,
              occlusionY: collision.y,
            };
            manifest.assets[key] = promoted;
            const temporary = `${manifestPath}.${process.pid}.tmp`;
            await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
            await rename(temporary, manifestPath);
            return json(res, 200, promoted);
          }
        } catch (error) {
          return json(res, 500, { error: error instanceof Error ? error.message : "Map editor request failed." });
        }
        next();
      });
    },
  };
}
