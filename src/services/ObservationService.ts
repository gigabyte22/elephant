import type { EmbeddingAdapter } from '../adapters/embeddings/types.ts';
import { read, write } from '../config/neo4j.ts';
import type { Observation } from '../models/types.ts';
import { ObservationRepository } from '../repositories/ObservationRepository.ts';
import { newId } from '../utils/ids.ts';

interface Deps {
  embedder: EmbeddingAdapter;
  ttlDays: number;
}

export function createObservationService(deps: Deps) {
  const { embedder, ttlDays } = deps;

  async function write_(input: {
    id?: string;
    agentId: string;
    sessionId: string;
    content: string;
  }): Promise<Observation> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlDays * 86_400_000);
    const embedding = await embedder.embed(input.content);
    const obs: Observation = {
      id: input.id ?? newId(),
      agentId: input.agentId,
      sessionId: input.sessionId,
      content: input.content,
      recordedAt: now,
      expiresAt,
      embedding,
    };
    return write((tx) => ObservationRepository.create(tx, obs));
  }

  async function listForSession(sessionId: string, limit = 100): Promise<Observation[]> {
    return read((tx) => ObservationRepository.listForSession(tx, sessionId, limit));
  }

  async function reapExpired(): Promise<number> {
    return write((tx) => ObservationRepository.reapExpired(tx, new Date()));
  }

  return { write: write_, listForSession, reapExpired };
}

export type ObservationService = ReturnType<typeof createObservationService>;
