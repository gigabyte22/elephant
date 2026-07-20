// Reciprocal Rank Fusion across per-type source lists.
// - Facts: fuse up to 3 lists (fact_vector, fact_fulltext, chunk_derived).
// - Chunks: fuse 2 lists (chunk_vector, chunk_fulltext).
// - KnowledgeChunks: fuse 2 lists (knowledge_chunk_vector, knowledge_chunk_fulltext).
// - Procedures: fuse 2 lists (procedure_vector, procedure_fulltext).
// - Preferences/Insights/Research: single-source; fusedScore = rawScore (we still
//   normalise it for downstream blended scoring).
//
// Score comparability across dense (cosine) and sparse (BM25) sources is the
// core reason we use RRF: ranks are the one thing both indexes produce on a
// shared scale. See src/utils/rrf.ts for the k=60 canonical default.

import { reciprocalRankFusion } from '../../../utils/rrf.ts';
import type { CandidateSource, RetrievalStage } from '../types.ts';

export function RrfFusionStage(): RetrievalStage {
  return {
    name: 'RrfFusion',
    async run(ctx, state) {
      fuseInto(
        state.facts,
        ['fact_vector', 'fact_fulltext', 'chunk_derived', 'entity_ppr'],
        ctx.config.rrfK,
      );
      fuseInto(state.chunks, ['chunk_vector', 'chunk_fulltext'], ctx.config.rrfK);
      fuseInto(
        state.knowledgeChunks,
        ['knowledge_chunk_vector', 'knowledge_chunk_fulltext'],
        ctx.config.rrfK,
      );
      fuseInto(state.procedures, ['procedure_vector', 'procedure_fulltext'], ctx.config.rrfK);
      fuseInto(
        state.researchChunks,
        ['research_chunk_vector', 'research_chunk_fulltext'],
        ctx.config.rrfK,
      );

      // --- Preferences / Insights / Research / Intentions (single-source) ---
      for (const p of state.preferences.values()) p.fusedScore = p.rawScore;
      for (const i of state.insights.values()) i.fusedScore = i.rawScore;
      for (const r of state.research.values()) r.fusedScore = r.rawScore;
      for (const i of state.intentions.values()) i.fusedScore = i.rawScore;

      return state;
    },
  };
}

// Run RRF over a single candidate map and write `fusedScore` back onto each entry.
function fuseInto<T extends FusableCandidate>(
  candidates: Map<string, T>,
  sources: CandidateSource[],
  rrfK: number,
): void {
  const lists = buildLists(candidates, sources);
  const fused = reciprocalRankFusion(lists, (item) => item.key, rrfK);
  for (const entry of fused) {
    const candidate = candidates.get(entry.key);
    if (candidate) candidate.fusedScore = entry.score;
  }
}

interface FusableCandidate {
  sources: Array<{ source: CandidateSource; rank: number }>;
  fusedScore?: number;
}

// Project a map<id, candidate> into one rank-ordered list per named source.
function buildLists<T extends FusableCandidate>(
  candidates: Map<string, T>,
  sources: CandidateSource[],
): Array<Array<{ key: string; rank: number }>> {
  const lists = sources.map(() => [] as Array<{ key: string; rank: number }>);
  for (const [key, candidate] of candidates.entries()) {
    for (const src of candidate.sources) {
      const slot = sources.indexOf(src.source);
      if (slot >= 0) lists[slot]!.push({ key, rank: src.rank });
    }
  }
  // Each list must be sorted by rank ASC for RRF to behave correctly.
  for (const l of lists) l.sort((a, b) => a.rank - b.rank);
  return lists;
}
