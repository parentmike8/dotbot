import { describe, expect, it, vi } from "vitest";
import { createServer } from "./app";

describe("persistence graceful degradation", () => {
  it("boots with one warning and functional auth when DATABASE_URL is absent", async () => {
    process.env.NODE_ENV = "test";
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { app, persistence } = await createServer({ databaseUrl: null });
    expect(persistence.live).toBe(false);
    expect(warning).toHaveBeenCalledOnce();
    expect(warning.mock.calls[0]?.[0]).toContain("continuing without database persistence");

    const registered = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "No DB" } });
    expect(registered.statusCode).toBe(200);
    const account = registered.json<{ playerId: string; token: string }>();
    const hello = await app.inject({ method: "POST", url: "/api/auth/hello", payload: { token: account.token } });
    expect(hello.statusCode).toBe(200);
    expect(hello.json<{ playerId: string }>().playerId).toBe(account.playerId);

    await app.close();
    warning.mockRestore();
  });

  it("falls back instead of failing startup when Postgres is unreachable", async () => {
    process.env.NODE_ENV = "test";
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { app, persistence } = await createServer({ databaseUrl: "postgres://postgres:postgres@127.0.0.1:1/dotbot" });
    expect(persistence.live).toBe(false);
    expect(warning).toHaveBeenCalledOnce();
    expect(warning.mock.calls[0]?.[0]).toContain("Postgres unavailable");
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    await app.close();
    warning.mockRestore();
  });
});
