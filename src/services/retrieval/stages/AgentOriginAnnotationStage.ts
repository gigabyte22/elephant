// Stamps originAgentId/originSessionId on each fact candidate using its
// sourceEpisodeId, so downstream scoring and filtering can apply agent- and
// session-scope logic without per-fact Cypher lookups.
//
// Facts without a sourceEpisodeId (direct POST /facts) keep both fields null —
// they're treated as shared / unscoped content, neither boosted nor demoted.

import { read } from '../../../config/neo4j.ts';
import { EpisodeRepository } from '../../../repositories/EpisodeRepository.ts';
import type { RetrievalStage } from '../types.ts';

export function AgentOriginAnnotationStage(): RetrievalStage {
  return {
    name: 'AgentOriginAnnotation',
    async run(_ctx, state) {
      const episodeIds = Array.from(
        new Set(
          Array.from(state.facts.values())
            .map((c) => c.fact.sourceEpisodeId)
            .filter((id): id is string => typeof id === 'string'),
        ),
      );

      const meta = episodeIds.length
        ? await read((tx) => EpisodeRepository.getManyMeta(tx, episodeIds))
        : undefined;

      for (const candidate of state.facts.values()) {
        const epId = candidate.fact.sourceEpisodeId;
        const m = epId ? meta?.get(epId) : undefined;
        candidate.originAgentId = m?.agentId ?? null;
        candidate.originSessionId = m?.sessionId ?? null;
      }
      return state;
    },
  };
}
