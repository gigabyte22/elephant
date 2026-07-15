// Ebbinghaus forgetting curve: retention = e^(-t/S), where S is "memory strength".
// S grows with each reference (spaced repetition) and with importance, so a
// fact the retrieval pipeline keeps touching — or one that matters — decays
// slower. importance 0 → 1x base strength, 0.5 → 3x, 0.75 → 4x.

export function ebbinghausRetention(input: {
  daysSinceLastReference: number;
  referenceCount: number;
  importance?: number;
}): number {
  const strength = (1 + input.referenceCount * 2) * (1 + (input.importance ?? 0.5) * 4);
  return Math.exp(-input.daysSinceLastReference / strength);
}

export interface PruneConfig {
  // Facts at or above this importance never auto-prune (durable biography).
  importanceExempt?: number;
  // Facts referenced within this many days are never pruned.
  minWindowDays?: number;
  // Prune when Ebbinghaus retention falls below this.
  retentionFloor?: number;
}

// True if the fact should be soft-pruned (validTo = now) by the dreaming pass.
// With defaults: importance 0.5 / refs 0 prunes days after the 30-day window;
// importance 0.6 / refs 3 survives ~71 unreferenced days; importance >= 0.75
// is permanent unless superseded. Anything retrieval keeps referencing keeps
// living — RefCountTickStage bumps lastReferencedAt on every recall.
export function shouldPrune(input: {
  importance: number;
  daysSinceLastReference: number;
  referenceCount: number;
  config?: PruneConfig;
}): boolean {
  const exempt = input.config?.importanceExempt ?? 0.75;
  const window = input.config?.minWindowDays ?? 30;
  const floor = input.config?.retentionFloor ?? 0.05;
  if (input.importance >= exempt) return false;
  if (input.daysSinceLastReference < window) return false;
  return (
    ebbinghausRetention({
      daysSinceLastReference: input.daysSinceLastReference,
      referenceCount: input.referenceCount,
      importance: input.importance,
    }) < floor
  );
}
