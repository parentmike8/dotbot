import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

/**
 * Dev-only capture endpoint for the style lab.
 *
 * The lab renders to a canvas, so the only way to review a frame at full
 * resolution — or hand one to someone — is to get the bitmap onto disk. This
 * accepts a base64 PNG from `/?lab&shots=1` and writes it under `tmp/lab/`.
 *
 * Never registered in a production build: it writes files and must not exist
 * outside a local dev server.
 */

const MAX_BODY_BYTES = 24 * 1024 * 1024;
const OUT_DIR = "tmp/lab";
const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

async function readBody(req: IncomingMessage): Promise<{ name?: string; png?: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Shot payload is too large.");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as { name?: string; png?: string };
}

export function labShotPlugin(): Plugin {
  return {
    name: "dotbot-lab-shot",
    apply: "serve",
    configureServer(server) {
      const root = server.config.root;
      server.middlewares.use("/__lab/shot", (req, res: ServerResponse, next) => {
        if (req.method !== "POST") {
          next();
          return;
        }
        void (async () => {
          try {
            const body = await readBody(req);
            const name = body.name ?? "";
            const png = body.png ?? "";
            if (!SAFE_NAME.test(name)) throw new Error(`Unsafe shot name: ${name}`);
            const base64 = png.replace(/^data:image\/png;base64,/, "");
            if (!base64 || base64.length === png.length) throw new Error("Expected a PNG data URL.");

            // apps/client is the vite root; shots belong at the repo root.
            const dir = resolve(root, "../..", OUT_DIR);
            await mkdir(dir, { recursive: true });
            const file = resolve(dir, `${name}.png`);
            await writeFile(file, Buffer.from(base64, "base64"));

            res.statusCode = 200;
            res.setHeader("content-type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ ok: true, file }));
          } catch (error) {
            res.statusCode = 400;
            res.setHeader("content-type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ ok: false, error: (error as Error).message }));
          }
        })();
      });
    },
  };
}
