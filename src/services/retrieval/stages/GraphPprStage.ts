// Personalized PageRank retrieval (HippoRAG-style). Seeds PageRank from the
// query-linked entities (QueryEntityLinkStage) UNION the entities of the top
// dense/full-text candidate facts — the "dense-sparse integration" idea: the
// query's own entities plus what the vector/FT layer already found. The
// resulting PageRank-ranked facts are added as a new `entity_ppr` source so
// RrfFusionStage blends them with the dense/FT lists.
//
// Runs BEFORE RrfFusionStage. Disabled by default — when off (the env default),
// this is a single boolean check and the recall path is unchanged. Degrades
// gracefully: no seeds, or a missing/failed GDS projection, leaves state as-is.

import type { LLMAdapter } from '../../../adapters/llm/types.ts';
import { read } from '../../../config/neo4j.ts';
import { EntityRepository } from '../../../repositories/EntityRepository.ts';
import { FactRepository } from '../../../repositories/FactRepository.ts';
import { PPR_GRAPH_NAME } from '../../graph/GraphProjectionService.ts';
import type { FactCandidate, RetrievalStage } from '../types.ts';

function bestRank(c: FactCandidate): number {
  let best = Number.POSITIVE_INFINITY;
  for (const s of c.sources) if (s.rank < best) best = s.rank;
  return best;
}

export function GraphPprStage(llm: LLMAdapter): RetrievalStage {
  return {
    name: 'GraphPpr',
    async run(ctx, state) {
      const enabled = ctx.query.ppr ?? ctx.config.ppr.enabled;
      if (!enabled) return state;

      // Seed from the entities of the best direct-hit facts so far...
      const directFacts = Array.from(state.facts.values())
        .filter((c) => c.hasDirectHit)
        .sort((a, b) => bestRank(a) - bestRank(b))
        .slice(0, ctx.config.ppr.seedTopFacts);
      const seeds = new Set<string>(ctx.queryEntityIds ?? []);
      for (const c of directFacts) for (const id of c.fact.entityIds) seeds.add(id);
      if (seeds.size === 0) return state;

      let seedIds = Array.from(seeds);

      // Recognition-memory filter (HippoRAG 2): optionally have the LLM prune
      // the seed set to entities actually relevant to the query before running
      // PageRank, so a spurious linked entity can't drag mass to off-topic
      // facts. Gated + default off; reuses the rerank capability over entity
      // names. Best-effort: any failure falls back to the unfiltered seeds.
      if (
        ctx.config.ppr.useRecognitionFilter &&
        typeof llm.rerank === 'function' &&
        seedIds.length > 1
      ) {
        try {
          const ents = await read((tx) => EntityRepository.getMany(tx, seedIds));
          if (ents.length > 1) {
            const ranked = await llm.rerank({
              query: ctx.query.q,
              candidates: ents.map((e) => ({ id: e.id, content: e.name })),
              keepTopK: ents.length,
            });
            const kept = ranked.filter((r) => r.score >= 0.3).map((r) => r.id);
            if (kept.length > 0) seedIds = kept;
          }
        } catch (err) {
          console.warn('[ppr] recognition filter failed, using all seeds:', (err as Error).message);
        }
      }

      const excludeFactIds = Array.from(state.facts.keys());
      let hits: Awaited<ReturnType<typeof FactRepository.pprFactsByEntities>>;
      try {
        hits = await read((tx) =>
          FactRepository.pprFactsByEntities(tx, {
            seedEntityIds: seedIds,
            excludeFactIds,
            limit: ctx.config.ppr.budget,
            includeSuperseded: ctx.query.includeSuperseded ?? false,
            graphName: PPR_GRAPH_NAME,
            dampingFactor: ctx.config.ppr.dampingFactor,
            maxIterations: ctx.config.ppr.maxIterations,
          }),
        );
      } catch (err) {
        // Missing projection / GDS error / stale seed → skip PPR, keep dense+FT.
        console.warn('[ppr] retrieval skipped:', (err as Error).message);
        return state;
      }

      hits.forEach((fact, i) => {
        const existing = state.facts.get(fact.id);
        if (existing) {
          // Already a dense/FT hit — give it an extra fusion list membership.
          existing.sources.push({ source: 'entity_ppr', rank: i, rawScore: fact.score });
          return;
        }
        const entry: FactCandidate = {
          fact,
          sources: [{ source: 'entity_ppr', rank: i, rawScore: fact.score }],
          expansionReason: 'entity_ppr',
          hasDirectHit: false,
        };
        state.facts.set(fact.id, entry);
      });
      return state;
    },
  };
}
