export type IdentityRateLimitAction = "register" | "verify" | "social_lookup" | "social_write";

export type IdentityRateLimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export interface IdentityRateLimiter {
  consume(action: IdentityRateLimitAction, key: string): IdentityRateLimitDecision;
}

const defaults: Record<IdentityRateLimitAction, { limit: number; windowMs: number }> = {
  register: { limit: 30, windowMs: 60 * 60_000 },
  verify: { limit: 60, windowMs: 10 * 60_000 },
  social_lookup: { limit: 120, windowMs: 60_000 },
  social_write: { limit: 60, windowMs: 60_000 },
};

export class MemoryIdentityRateLimiter implements IdentityRateLimiter {
  private readonly buckets = new Map<string, number[]>();

  constructor(
    private readonly policy = defaults,
    private readonly now: () => number = Date.now,
    private readonly maxBuckets = 10_000,
  ) {}

  consume(action: IdentityRateLimitAction, key: string): IdentityRateLimitDecision {
    const policy = this.policy[action];
    const now = this.now();
    const bucketKey = `${action}:${key}`;
    if (!this.buckets.has(bucketKey) && this.buckets.size >= this.maxBuckets) {
      for (const [existingKey, timestamps] of this.buckets) {
        const existingAction = existingKey.slice(0, existingKey.indexOf(":")) as IdentityRateLimitAction;
        if (timestamps.every((timestamp) => now - timestamp >= this.policy[existingAction].windowMs)) this.buckets.delete(existingKey);
      }
      while (this.buckets.size >= this.maxBuckets) this.buckets.delete(this.buckets.keys().next().value!);
    }
    const recent = (this.buckets.get(bucketKey) ?? []).filter((timestamp) => now - timestamp < policy.windowMs);
    if (recent.length >= policy.limit) {
      this.buckets.set(bucketKey, recent);
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((policy.windowMs - (now - recent[0])) / 1000)) };
    }
    recent.push(now);
    this.buckets.set(bucketKey, recent);
    return { allowed: true };
  }
}
