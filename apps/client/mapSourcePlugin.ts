import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

/**
 * Dev-only patch endpoint for Map Studio.
 *
 * The editor's whole value is that it writes back into the same authored source
 * an LLM reads, so the round trip has to touch the real file. That means writing
 * to disk, which is why this exists only on a local dev server and is never
 * registered in a production build.
 *
 * The patching itself is `packages/game/src/mapSourcePatch.ts` — a pure function
 * with its own tests. This is only the transport, and its one job beyond that is
 * to refuse a path it was not meant to write.
 */

const MAX_BODY_BYTES = 512 * 1024;
/** Authored map source lives here and nowhere else. */
const ALLOWED = /^packages\/game\/src\/content\/[A-Za-z0-9]+\.ts$/;

type PatchRequest = { file?: string; text?: string; base?: string };

async function readBody(req: IncomingMessage): Promise<PatchRequest> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Patch payload is too large.");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as PatchRequest;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export function mapSourcePlugin(): Plugin {
  return {
    name: "dotbot-map-source",
    apply: "serve",
    configureServer(server) {
      // apps/client is the vite root; content lives at the repo root.
      const repo = resolve(server.config.root, "../..");

      /** Hand the editor the file it is about to patch, so it patches what is on disk. */
      server.middlewares.use("/__studio/read", (req, res: ServerResponse, next) => {
        if (req.method !== "GET") {
          next();
          return;
        }
        void (async () => {
          try {
            const file = new URL(req.url ?? "", "http://studio").searchParams.get("file") ?? "";
            if (!ALLOWED.test(file)) throw new Error(`Refusing to read ${file}`);
            send(res, 200, { ok: true, text: await readFile(resolve(repo, file), "utf8") });
          } catch (error) {
            send(res, 400, { ok: false, error: (error as Error).message });
          }
        })();
      });

      server.middlewares.use("/__studio/write", (req, res: ServerResponse, next) => {
        if (req.method !== "POST") {
          next();
          return;
        }
        void (async () => {
          try {
            const { file = "", text = "", base } = await readBody(req);
            if (!ALLOWED.test(file)) throw new Error(`Refusing to write ${file}`);
            if (!text.includes("SourceBuilding")) {
              throw new Error("That does not look like a map-source file; refusing to overwrite it.");
            }
            const path = resolve(repo, file);
            /**
             * The editor patches the text it last read. If the file has moved on
             * since — an LLM edited it, or a second tab saved — that patch is
             * against a stale base and applying it would silently drop the other
             * change. Refuse and let the editor reload.
             */
            const onDisk = await readFile(path, "utf8");
            if (base !== undefined && base !== onDisk) {
              throw new Error(`${file} changed on disk since Studio read it. Reload before saving.`);
            }
            await writeFile(path, text, "utf8");
            send(res, 200, { ok: true, file });
          } catch (error) {
            send(res, 400, { ok: false, error: (error as Error).message });
          }
        })();
      });
    },
  };
}
