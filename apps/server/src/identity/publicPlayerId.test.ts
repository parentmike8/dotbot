import { describe, expect, it, vi } from "vitest";
import { allocateUniquePublicPlayerId, formatPublicPlayerId, normalizePublicPlayerId } from "./publicPlayerId";

describe("public player IDs", () => {
  it("normalizes case and display punctuation without accepting ambiguous characters", () => {
    expect(normalizePublicPlayerId("abcd-efgh")).toBe("ABCDEFGH");
    expect(formatPublicPlayerId("abcdefgh")).toBe("ABCD-EFGH");
    expect(normalizePublicPlayerId("ABCI-EFGH")).toBeNull();
    expect(normalizePublicPlayerId("ABCO-EFGH")).toBeNull();
    expect(normalizePublicPlayerId("ABC0-EFGH")).toBeNull();
    expect(normalizePublicPlayerId("ABC1-EFGH")).toBeNull();
  });

  it("retries a case-insensitive collision and returns only the successful candidate", async () => {
    const candidates = ["abcd-efgh", "JKLM-NPQR"];
    const insert = vi.fn(async (candidate: string) => candidate === "ABCDEFGH" ? null : { candidate });
    await expect(allocateUniquePublicPlayerId(insert, () => candidates.shift()!)).resolves.toEqual({ candidate: "JKLMNPQR" });
    expect(insert.mock.calls).toEqual([["ABCDEFGH"], ["JKLMNPQR"]]);
  });

  it("fails explicitly when collision retries are exhausted", async () => {
    await expect(allocateUniquePublicPlayerId(async () => null, () => "ABCDEFGH", 2))
      .rejects.toThrow("Could not allocate a unique public player ID");
  });
});
