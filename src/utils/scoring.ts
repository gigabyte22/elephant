// importance = recency*0.4 + referenceCount*0.3 + explicit*0.3   (per SPEC.md §5)

const HALF_LIFE_DAYS = 30;

export function recencyScore(
  recordedAt: Date,
  now: Date = new Date(),
  halfLifeDays: number = HALF_LIFE_DAYS,
): number {
  const ageDays = (now.getTime() - recordedAt.getTime()) / (1000 * 60 * 60 * 24);
  // Exponential decay; ageDays=0 → 1, ageDays=halfLifeDays → 0.5.
  return 0.5 ** (ageDays / halfLifeDays);
}

export function referenceScore(refCount: number): number {
  // log scale so heavily-referenced facts saturate cleanly at 1.
  return Math.min(1, Math.log1p(refCount) / Math.log(11));
}

export function importance(input: {
  recordedAt: Date;
  referenceCount: number;
  explicit: boolean; // true = user/agent explicitly saved (POST /facts), false = LLM-extracted
  now?: Date;
}): number {
  const r = recencyScore(input.recordedAt, input.now);
  const ref = referenceScore(input.referenceCount);
  const explicit = input.explicit ? 1 : 0;
  return Math.max(0, Math.min(1, r * 0.4 + ref * 0.3 + explicit * 0.3));
}
