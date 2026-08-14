import type { ManagedTransaction } from 'neo4j-driver';
import type { Episode, EpisodeOrigin, EpisodeParticipant } from '../models/types.ts';
import { dateParam, nullableDateParam, toJsDate, toJsDateOrNull } from '../utils/neo4j-conv.ts';
import { memoryItemParams, memoryItemSetClause, readScope } from './scope.ts';

// Participants persist as a JSON-string prop: Neo4j properties hold only
// primitives and homogeneous arrays without nulls, so an array of
// {label, userId?} objects has no native encoding. Parsed defensively —
// a hand-edited or corrupted prop degrades to "no participants" (legacy
// attribution) rather than failing every read of the episode.
function parseParticipants(raw: unknown): EpisodeParticipant[] | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function toEpisode(node: Record<string, unknown>): Episode {
  return {
    id: node.id as string,
    agentId: node.agentId as string,
    sessionId: node.sessionId as string,
    timestamp: toJsDate(node.timestamp),
    rawTranscript: node.rawTranscript as string,
    summary: node.summary as string,
    embedding: (node.embedding as number[]) ?? [],
    origin: (node.origin as EpisodeOrigin | undefined) ?? undefined,
    participants: parseParticipants(node.participants),
    isolated: (node.isolated as boolean | undefined) ?? undefined,
    summaryProvisional: (node.summaryProvisional as boolean | undefined) ?? undefined,
    recordedAt: node.recordedAt != null ? toJsDate(node.recordedAt) : undefined,
    dreamedAt: toJsDateOrNull(node.dreamedAt),
    dreamAttempts: (node.dreamAttempts as number | undefined) ?? 0,
    dreamNextAttemptAt: toJsDateOrNull(node.dreamNextAttemptAt),
    dreamLastError: (node.dreamLastError as string | undefined) ?? undefined,
    ...readScope(node),
  };
}

export const EpisodeRepository = {
  async create(tx: ManagedTransaction, ep: Episode): Promise<Episode> {
    const result = await tx.run(
      `MERGE (e:Episode {id: $id})
       SET ${memoryItemSetClause('e')},
           e.agentId = $agentId,
           e.sessionId = $sessionId,
           e.timestamp = datetime($timestamp),
           e.rawTranscript = $rawTranscript,
           e.summary = $summary,
           e.embedding = $embedding,
           e.origin = $origin,
           e.participants = $participants,
           e.isolated = $isolated,
           e.summaryProvisional = $summaryProvisional,
           e.recordedAt = coalesce(e.recordedAt, datetime($recordedAt))
       RETURN e {.*} AS e`,
      {
        id: ep.id,
        agentId: ep.agentId,
        sessionId: ep.sessionId,
        timestamp: dateParam(ep.timestamp),
        rawTranscript: ep.rawTranscript,
        summary: ep.summary,
        embedding: ep.embedding,
        origin: ep.origin ?? null,
        participants: ep.participants?.length ? JSON.stringify(ep.participants) : null,
        isolated: ep.isolated ?? null,
        summaryProvisional: ep.summaryProvisional ?? null,
        // coalesce above: a re-POST must not reset the original write time.
        recordedAt: dateParam(ep.recordedAt ?? new Date()),
        ...memoryItemParams('episode', ep),
      },
    );
    return toEpisode(result.records[0]!.get('e'));
  },

  async get(tx: ManagedTransaction, id: string): Promise<Episode | null> {
    const result = await tx.run('MATCH (e:Episode {id: $id}) RETURN e {.*} AS e', { id });
    const record = result.records[0];
    return record ? toEpisode(record.get('e')) : null;
  },

  async listSince(tx: ManagedTransaction, since: Date): Promise<Episode[]> {
    const result = await tx.run(
      `MATCH (e:Episode)
       WHERE e.timestamp >= datetime($since)
       RETURN e {.*} AS e
       ORDER BY e.timestamp ASC`,
      { since: dateParam(since) },
    );
    return result.records.map((r) => toEpisode(r.get('e')));
  },

  // `since` is exclusive — the dream cursor points at the last-processed
  // timestamp, so we want strictly-greater to avoid re-processing.
  // Work-queue selector for the dream cycle.
  //
  // This replaces a single global cursor keyed on the CLIENT-supplied
  // e.timestamp, which produced two silent data-loss modes:
  //   - any episode POSTed with a timestamp older than the cursor (i.e. the
  //     backfill/import case the `ingest` origin exists to serve) was never
  //     selected, forever, and backlogEstimate read zero;
  //   - the cursor advanced past FAILED episodes, so a transient embedder or
  //     LLM outage destroyed that window permanently.
  //
  // Asking for work directly is immune to both: nothing depends on ordering
  // against client time, a failure simply stays selectable, and a crash leaves
  // no cursor to resume.
  async listPendingDream(
    tx: ManagedTransaction,
    input: { limit: number; maxAttempts: number; now?: Date },
  ): Promise<Episode[]> {
    const result = await tx.run(
      `MATCH (e:Episode)
       WHERE e.dreamedAt IS NULL
         AND coalesce(e.dreamAttempts, 0) < $maxAttempts
         AND (e.dreamNextAttemptAt IS NULL OR e.dreamNextAttemptAt <= datetime($now))
       RETURN e {.*} AS e
       ORDER BY coalesce(e.recordedAt, e.timestamp) ASC
       LIMIT toInteger($limit)`,
      {
        limit: input.limit,
        maxAttempts: input.maxAttempts,
        now: dateParam(input.now ?? new Date()),
      },
    );
    return result.records.map((r) => toEpisode(r.get('e')));
  },

  // Episodes still carrying a clipped-head summary. Oldest first, so a backlog
  // drains in arrival order. Deliberately not joined to the dream queue: an
  // episode whose facts are extracted still needs its summary upgraded, and one
  // that is dead-lettered for extraction still deserves a searchable summary.
  async listProvisionalSummaries(
    tx: ManagedTransaction,
    limit: number,
  ): Promise<Array<Pick<Episode, 'id' | 'rawTranscript'>>> {
    const result = await tx.run(
      `MATCH (e:Episode)
       WHERE e.summaryProvisional = true
       RETURN e.id AS id, e.rawTranscript AS rawTranscript
       ORDER BY coalesce(e.recordedAt, e.timestamp) ASC
       LIMIT toInteger($limit)`,
      { limit },
    );
    return result.records.map((r) => ({
      id: r.get('id') as string,
      rawTranscript: r.get('rawTranscript') as string,
    }));
  },

  /** Replace a provisional summary with the real one and its fresh embedding. */
  async installSummary(
    tx: ManagedTransaction,
    input: { id: string; summary: string; embedding: number[] },
  ): Promise<void> {
    await tx.run(
      `MATCH (e:Episode {id: $id})
       SET e.summary = $summary,
           e.embedding = $embedding,
           e.summaryProvisional = false`,
      input,
    );
  },

  // Backlog for /health: episodes still eligible for a dream attempt,
  // regardless of backoff (an operator wants the outstanding total, not the
  // subset that happens to be due this instant).
  async countPendingDream(tx: ManagedTransaction, maxAttempts: number): Promise<number> {
    const result = await tx.run(
      `MATCH (e:Episode)
       WHERE e.dreamedAt IS NULL AND coalesce(e.dreamAttempts, 0) < $maxAttempts
       RETURN count(e) AS n`,
      { maxAttempts },
    );
    // Driver runs with disableLosslessIntegers=true, so count() is a JS number.
    return (result.records[0]?.get('n') as number) ?? 0;
  },

  // Episodes that exhausted their attempts. Previously this population was
  // invisible: only an in-memory counter recorded that anything was lost, and
  // WHICH episodes existed solely in a console.error line.
  async countDeadLetteredDream(tx: ManagedTransaction, maxAttempts: number): Promise<number> {
    const result = await tx.run(
      `MATCH (e:Episode)
       WHERE e.dreamedAt IS NULL AND coalesce(e.dreamAttempts, 0) >= $maxAttempts
       RETURN count(e) AS n`,
      { maxAttempts },
    );
    return (result.records[0]?.get('n') as number) ?? 0;
  },

  async markDreamed(tx: ManagedTransaction, id: string, at: Date): Promise<void> {
    await tx.run(
      `MATCH (e:Episode {id: $id})
       SET e.dreamedAt = datetime($at), e.dreamNextAttemptAt = NULL`,
      { id, at: dateParam(at) },
    );
  },

  // Exponential backoff on the episode itself, so a poisoned episode neither
  // pins the cycle nor disappears. Returns the new attempt count so the caller
  // can report a dead-letter transition.
  async recordDreamFailure(
    tx: ManagedTransaction,
    input: { id: string; nextAttemptAt: Date | null; error: string },
  ): Promise<number> {
    const result = await tx.run(
      `MATCH (e:Episode {id: $id})
       SET e.dreamAttempts = coalesce(e.dreamAttempts, 0) + 1,
           e.dreamLastError = $error,
           e.dreamNextAttemptAt = CASE
             WHEN $nextAttemptAt IS NULL THEN NULL ELSE datetime($nextAttemptAt) END
       RETURN e.dreamAttempts AS attempts`,
      {
        id: input.id,
        error: input.error.slice(0, 500),
        nextAttemptAt: nullableDateParam(input.nextAttemptAt),
      },
    );
    return (result.records[0]?.get('attempts') as number) ?? 0;
  },

  // Batched lookup of just the scoping metadata for a set of episodes.
  // Retrieval uses this to stamp originAgentId/originSessionId on fact candidates
  // without hydrating full Episode records.
  async getManyMeta(
    tx: ManagedTransaction,
    ids: string[],
  ): Promise<Map<string, { agentId: string; sessionId: string }>> {
    if (ids.length === 0) return new Map();
    const result = await tx.run(
      `UNWIND $ids AS id
       MATCH (e:Episode {id: id})
       RETURN e.id AS id, e.agentId AS agentId, e.sessionId AS sessionId`,
      { ids },
    );
    const out = new Map<string, { agentId: string; sessionId: string }>();
    for (const r of result.records) {
      out.set(r.get('id') as string, {
        agentId: r.get('agentId') as string,
        sessionId: r.get('sessionId') as string,
      });
    }
    return out;
  },
};
