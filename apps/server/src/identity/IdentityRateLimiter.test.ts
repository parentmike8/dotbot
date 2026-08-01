import { describe, expect, it } from "vitest";
import { MemoryIdentityRateLimiter } from "./IdentityRateLimiter";

describe("identity abuse limiter", () => {
  it("isolates actions and callers, rejects the over-limit request, and recovers after the window", () => {
    let now = 1_000;
    const limiter = new MemoryIdentityRateLimiter({
      register: { limit: 2, windowMs: 1_000 },
      verify: { limit: 2, windowMs: 1_000 },
      social_lookup: { limit: 2, windowMs: 1_000 },
      social_write: { limit: 2, windowMs: 1_000 },
    }, () => now);
    expect(limiter.consume("register", "ip-a")).toEqual({ allowed: true });
    expect(limiter.consume("register", "ip-a")).toEqual({ allowed: true });
    expect(limiter.consume("register", "ip-a")).toMatchObject({ allowed: false, retryAfterSeconds: 1 });
    expect(limiter.consume("verify", "ip-a")).toEqual({ allowed: true });
    expect(limiter.consume("register", "ip-b")).toEqual({ allowed: true });
    now += 1_001;
    expect(limiter.consume("register", "ip-a")).toEqual({ allowed: true });
  });

  it("bounds caller buckets under distributed-key abuse", () => {
    const limiter = new MemoryIdentityRateLimiter({
      register: { limit: 2, windowMs: 1_000 },
      verify: { limit: 2, windowMs: 1_000 },
      social_lookup: { limit: 2, windowMs: 1_000 },
      social_write: { limit: 2, windowMs: 1_000 },
    }, () => 1_000, 2);
    expect(limiter.consume("register", "ip-a")).toEqual({ allowed: true });
    expect(limiter.consume("register", "ip-b")).toEqual({ allowed: true });
    expect(limiter.consume("register", "ip-c")).toEqual({ allowed: true });
    // ip-a was the bounded eviction candidate, so it starts a fresh bucket.
    expect(limiter.consume("register", "ip-a")).toEqual({ allowed: true });
  });
});
