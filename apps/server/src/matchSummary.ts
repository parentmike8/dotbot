import { PUBLIC_EXTRACTION_ROLE_COUNT } from "@dotbot/protocol";

const aggregateOutcomeKeys = ["extracted", "died", "timeout", "disconnected"] as const;

export type AggregateMatchSummary = {
  reason: string;
  participantCount: number;
  outcomes: Partial<Record<(typeof aggregateOutcomeKeys)[number], number>>;
};

export function isAggregateMatchSummary(value: unknown): value is AggregateMatchSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const summary = value as Record<string, unknown>;
  if (Object.keys(summary).length !== 3
    || !Object.keys(summary).every((key) => key === "reason" || key === "participantCount" || key === "outcomes")) return false;
  if (typeof summary.reason !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(summary.reason)) return false;
  if (!Number.isInteger(summary.participantCount)
    || (summary.participantCount as number) < 0
    || (summary.participantCount as number) > PUBLIC_EXTRACTION_ROLE_COUNT) return false;
  if (!summary.outcomes || typeof summary.outcomes !== "object" || Array.isArray(summary.outcomes)) return false;
  const outcomes = summary.outcomes as Record<string, unknown>;
  if (!Object.keys(outcomes).every((key) => aggregateOutcomeKeys.includes(key as (typeof aggregateOutcomeKeys)[number]))) return false;
  if (!Object.values(outcomes).every((count) => Number.isInteger(count) && (count as number) > 0)) return false;
  return Object.values(outcomes).reduce<number>((total, count) => total + (count as number), 0) === summary.participantCount;
}
