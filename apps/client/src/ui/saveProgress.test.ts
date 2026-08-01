import { describe, expect, it } from "vitest";
import { shouldOfferSaveProgress } from "./saveProgress";
import type { AccountState } from "./identity";

describe("post-run account durability offer", () => {
  it("offers saving only after a run to an unlinked guest with authoritative storage", () => {
    const guest: AccountState = { publicPlayerId: "ABCD-EFGH", displayName: "Guest", linked: false, providers: [], storageAvailable: true };
    expect(shouldOfferSaveProgress(false, guest)).toBe(false);
    expect(shouldOfferSaveProgress(true, guest)).toBe(true);
    expect(shouldOfferSaveProgress(true, { ...guest, linked: true })).toBe(false);
    expect(shouldOfferSaveProgress(true, { ...guest, storageAvailable: false })).toBe(false);
  });
});
