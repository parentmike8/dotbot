import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { mapSourcePlugin } from "./mapSourcePlugin";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

type Reply = { status: number; body: { ok: boolean; error?: string } };

describe("Map Studio compare-and-write transport", () => {
  let disk: string;
  let writeHandler: (
    req: Readable & { method: string; url: string },
    res: {
      statusCode: number;
      setHeader: () => void;
      end: (body: string) => void;
    },
    next: () => void,
  ) => void;

  beforeEach(() => {
    disk = "export const region: OutdoorPlan = base;";
    vi.mocked(readFile).mockImplementation(async () => disk);
    vi.mocked(writeFile).mockImplementation(async (_path, text) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      disk = String(text);
    });
    const handlers = new Map<string, typeof writeHandler>();
    const plugin = mapSourcePlugin();
    const configure = plugin.configureServer as (server: unknown) => void;
    configure({
      config: { root: "/repo/apps/client" },
      middlewares: {
        use: (path: string, handler: typeof writeHandler) => handlers.set(path, handler),
      },
    });
    writeHandler = handlers.get("/__studio/write")!;
  });

  function write(text: string): Promise<Reply> {
    const req = Readable.from([Buffer.from(JSON.stringify({
      file: "packages/game/src/content/downtown.ts",
      base: "export const region: OutdoorPlan = base;",
      text,
    }))]) as Readable & { method: string; url: string };
    req.method = "POST";
    req.url = "";
    return new Promise((resolve) => {
      const res = {
        statusCode: 0,
        setHeader: () => {},
        end: (body: string) => resolve({
          status: res.statusCode,
          body: JSON.parse(body) as Reply["body"],
        }),
      };
      writeHandler(req, res, () => {});
    });
  }

  it("serializes same-file writes so only one matching baseline can win", async () => {
    const firstText = "export const region: OutdoorPlan = first;";
    const secondText = "export const region: OutdoorPlan = second;";

    const replies = await Promise.all([write(firstText), write(secondText)]);

    expect(replies.filter((reply) => reply.body.ok)).toHaveLength(1);
    expect(replies.filter((reply) => !reply.body.ok)).toHaveLength(1);
    expect(replies.find((reply) => !reply.body.ok)?.body.error).toMatch(/changed on disk|stale|reload/i);
    expect([firstText, secondText]).toContain(disk);
  });
});
