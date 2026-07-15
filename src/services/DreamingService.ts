import type { ManagedTransaction } from 'neo4j-driver';
import type { EmbeddingAdapter } from '../adapters/embeddings/types.ts';
import { JsonExtractionError } from '../adapters/llm/json-prompt.ts';
import type { LLMAdapter } from '../adapters/llm/types.ts';
import { read, write } from '../config/neo4j.ts';
import type {
  AuditEventKind,
  Chunk,
  DreamRun,
  Episode,
  Fact,
  Insight,
  MemoryKind,
} from '../models/types.ts';
import { resolveExtractedEntities } from '../models/types.ts';
import { ChunkRepository } from '../repositories/ChunkRepository.ts';
import { DreamCursorRepository } from '../repositories/DreamCursorRepository.ts';
import { DreamRunRepository } from '../repositories/DreamRunRepository.ts';
import { EntityRepository } from '../repositories/EntityRepository.ts';
import { EpisodeRepository } from '../repositories/EpisodeRepository.ts';
import { FactRepository } from '../repositories/FactRepository.ts';
import { InsightRepository } from '../repositories/InsightRepository.ts';
import { AsyncMutex } from '../utils/AsyncMutex.ts';
import { clusterForConsolidation } from '../utils/consolidation.ts';
import { cosine } from '../utils/cosine.ts';
import { shouldPrune } from '../utils/decay.ts';
import { newId } from '../utils/ids.ts';
import { AuditService } from './AuditService.ts';
import type { GraphProjectionService } from './graph/GraphProjectionService.ts';

const DREAMER_ACTOR = 'dreamer';

interface Deps {
  llm: LLMAdapter;
  embedder: EmbeddingAdapter;
  config: {
    maxEpisodesPerRun: number;
    deadlineMs: number;
    // Knowledge-graph construction (off the hot path). When relation extraction
    // is on, the dreamer pulls (:Entity)-[:RELATES]->(:Entity) triples per
    // episode; when entity resolution is on, it re-embeds touched entities from
    // their name and links semantic duplicates with :SYNONYM edges.
    enableRelationExtraction: boolean;
    relationMinConfidence: number;
    enableEntityResolution: boolean;
    synonymThreshold: number;
    synonymCandidates: number;
    // Refresh the GDS projection PPR retrieval reads, at the end of each cycle.
    refreshProjection: boolean;
    // Fact hygiene. Dedup skips new facts too similar to a live fact; the
    // supersede threshold floors the contradiction-candidate vector search;
    // crossScopeDedup widens both searches to the unscoped personal bucket.
    dedupThreshold: number;
    supersedeVectorThreshold: number;
    promoteInsightImportance: number;
    crossScopeDedup: boolean;
    // Pruning (see utils/decay.ts for the retention model).
    pruneWindowDays: number;
    pruneBatchLimit: number;
    pruneImportanceExempt: number;
    pruneRetentionFloor: number;
    // Consolidation: LLM-merge fragment facts clustered per entity.
    enableConsolidation: boolean;
    consolidationMaxClustersPerRun: number;
    consolidationMaxClusterSize: number;
    consolidationMinSimilarity: number;
    consolidationMinEntityFacts: number;
  };
  // Optional — only needed when refreshProjection is on (PPR enabled).
  graphProjection?: GraphProjectionService;
}

// Bounding input bounds output: ~20 facts per call ≈ ~1200 tokens of JSON,
// well under the 8192 max_tokens response cap.
const EXTRACTION_CONTEXT_USABLE = 0.75;
const EXTRACTION_INPUT_TOKEN_CAP = 2000;

export class DreamInProgressError extends Error {
  constructor(public readonly runningJobId: string) {
    super(`dream run ${runningJobId} is already in progress`);
    this.name = 'DreamInProgressError';
  }
}

function newDreamRun(id?: string): DreamRun {
  return {
    id: id ?? newId(),
    startedAt: new Date(),
    completedAt: null,
    status: 'running',
    episodesProcessed: 0,
    episodesFailed: 0,
    factsCreated: 0,
    factsSuperseded: 0,
    factsPruned: 0,
    factsMerged: 0,
    insightsPromoted: 0,
    extractionFailures: 0,
    supersedeFailures: 0,
    relationsCreated: 0,
    synonymsCreated: 0,
    entitiesReembedded: 0,
  };
}

function logLLMError(prefix: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`${prefix}: ${msg}`);
  if (err instanceof JsonExtractionError) {
    console.error(
      `--- raw response (${err.raw.length} chars) ---\n${err.raw}\n--- end raw response ---`,
    );
  }
}

// Every audit event emitted by the dreamer carries the same actor and tags the
// originating run. This trims the four mutation call-sites to just the fields
// that actually differ between them.
async function recordDreamerEvent(
  tx: ManagedTransaction,
  run: DreamRun,
  args: {
    kind: AuditEventKind;
    targetId: string;
    targetKind: MemoryKind;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  await AuditService.record({
    tx,
    kind: args.kind,
    targetId: args.targetId,
    targetKind: args.targetKind,
    actor: DREAMER_ACTOR,
    payload: { dreamRunId: run.id, ...args.payload },
  });
}

export function createDreamingService(deps: Deps) {
  const { llm, embedder, config } = deps;

  // Serializes /dream invocations + the cron. Second caller gets thrown
  // DreamInProgressError, which HTTP maps to 409.
  const cycleMutex = new AsyncMutex();
  let runningJobId: string | null = null;
  let lastRunDurationMs: number | null = null;

  // jobs[jobId] is consulted by /dream/:jobId for status polling.
  const jobs = new Map<string, DreamRun>();

  function trigger(): { jobId: string } {
    // Fast-fail when already running so callers can decide whether to retry
    // or poll an existing job.
    if (runningJobId) throw new DreamInProgressError(runningJobId);

    const run = newDreamRun();
    jobs.set(run.id, run);

    // Persist the run record then kick off the async cycle.
    void write((tx) => DreamRunRepository.create(tx, run))
      .then(() => runCycle(run.id))
      .catch((err) => {
        if (err instanceof DreamInProgressError) {
          // A second trigger raced with us — leave the first run alone.
          return;
        }
        const updated: DreamRun = {
          ...(jobs.get(run.id) ?? run),
          status: 'failed',
          completedAt: new Date(),
          error: err instanceof Error ? err.message : String(err),
        };
        jobs.set(run.id, updated);
        void write((tx) => DreamRunRepository.update(tx, run.id, updated));
      });

    return { jobId: run.id };
  }

  async function status(jobId: string): Promise<DreamRun | null> {
    const cached = jobs.get(jobId);
    if (cached) return cached;
    return read((tx) => DreamRunRepository.get(tx, jobId));
  }

  async function lastCompleted(): Promise<DreamRun | null> {
    return read((tx) => DreamRunRepository.getLastCompleted(tx));
  }

  // Estimated backlog = episodes newer than the cursor (falling back to last
  // completed dream's timestamp, then epoch). Cheap count for /health.
  async function backlogEstimate(): Promise<number> {
    const cursor =
      (await read((tx) => DreamCursorRepository.get(tx))) ??
      (await lastCompleted())?.completedAt ??
      new Date(0);
    return read((tx) => EpisodeRepository.countAfter(tx, cursor));
  }

  // Awaitable variant for tests / CLI.
  async function runCycle(jobId?: string): Promise<DreamRun> {
    const lock = cycleMutex.tryAcquire();
    if (!lock) {
      throw new DreamInProgressError(runningJobId ?? '(unknown)');
    }

    const run = (jobId && jobs.get(jobId)) || newDreamRun(jobId);
    jobs.set(run.id, run);
    runningJobId = run.id;
    const t0 = Date.now();
    const deadline = t0 + config.deadlineMs;

    try {
      // Cursor seeds from: persistent cursor → last completed run → epoch.
      // Using a cursor instead of "last dream run timestamp" means a
      // time-boxed run resumes mid-backlog on the next invocation.
      const initialCursor =
        (await read((tx) => DreamCursorRepository.get(tx))) ??
        (await lastCompleted())?.completedAt ??
        new Date(0);

      const episodes = await read((tx) =>
        EpisodeRepository.listAfterLimit(tx, {
          after: initialCursor,
          limit: config.maxEpisodesPerRun,
        }),
      );

      // Chronological processing. Within one episode, facts are siblings
      // (no mutual supersede); across episodes, later facts CAN supersede
      // earlier ones. Preserves cross-episode contradiction detection while
      // preventing the LLM from declaring sibling facts both winners.
      const allCreated: Fact[] = [];
      const supersededInCycle = new Set<string>();
      // Entities upserted/seen this cycle, fed to the entity-resolution step so
      // re-embedding + synonymy work over just what changed, not the whole graph.
      const touchedEntityIds = new Set<string>();
      let processed = 0;
      let hitDeadline = false;

      for (const ep of episodes) {
        if (Date.now() >= deadline) {
          hitDeadline = true;
          break;
        }
        try {
          const created = await processEpisode(ep, supersededInCycle, touchedEntityIds, run);
          allCreated.push(...created);
        } catch (err) {
          // A poisoned episode must not pin the cursor — log, count, advance.
          run.episodesFailed += 1;
          logLLMError(`[dream ${run.id}] episode ${ep.id} failed, skipping`, err);
        }
        processed += 1;
        await write((tx) => DreamCursorRepository.set(tx, ep.timestamp));
      }

      run.episodesProcessed = processed;

      // Skip promotion/prune if we're time-boxed out — those walk the whole
      // Fact graph and would blow the budget further.
      if (!hitDeadline) {
        // Entity resolution is best-effort: a failure here must not fail the
        // cycle (facts are already persisted), so it's caught and logged.
        try {
          await resolveEntityGraph(touchedEntityIds, run);
        } catch (err) {
          logLLMError(`[dream ${run.id}] entity resolution failed, skipping`, err);
        }
        // Consolidation runs before promote/prune so promotion sees the merged
        // canonical fact and prune evaluates the consolidated set.
        try {
          await consolidateFactsPass(run, deadline, touchedEntityIds, supersededInCycle);
        } catch (err) {
          logLLMError(`[dream ${run.id}] consolidation failed, skipping`, err);
        }
        await promoteHighImportanceInsights(allCreated, supersededInCycle, run);
        await pruneStale(run);
      }

      // Rebuild the GDS projection so PPR retrieval sees this cycle's new
      // relation/synonym edges. Runs even when time-boxed out (hitDeadline):
      // it's a cheap single reproject, and a missing/stale projection disables
      // PPR entirely — on a slow backlog every cycle hits the deadline, so
      // gating this behind !hitDeadline would mean the projection never rebuilds.
      // Best-effort: a GDS hiccup (or missing plugin) must not fail the cycle —
      // recall just keeps using the prior projection.
      if (config.refreshProjection && deps.graphProjection) {
        try {
          await deps.graphProjection.refresh();
        } catch (err) {
          logLLMError(`[dream ${run.id}] PPR projection refresh failed, skipping`, err);
        }
      }

      return await finalise(run);
    } catch (err) {
      logLLMError(`[dream ${run.id}] cycle failed`, err);
      const failed: DreamRun = {
        ...run,
        status: 'failed',
        completedAt: new Date(),
        error: err instanceof Error ? err.message : String(err),
      };
      jobs.set(failed.id, failed);
      await write((tx) => DreamRunRepository.update(tx, failed.id, failed));
      throw err;
    } finally {
      lastRunDurationMs = Date.now() - t0;
      runningJobId = null;
      lock.release();
    }
  }

  // Extract → embed → dedup → persist → supersede for a single episode.
  // Mutates `run` counters and `supersededInCycle`.
  async function processEpisode(
    ep: Episode,
    supersededInCycle: Set<string>,
    touchedEntityIds: Set<string>,
    run: DreamRun,
  ): Promise<Fact[]> {
    const sample = await read((tx) =>
      FactRepository.listSimilar(tx, {
        embedding: ep.embedding,
        limit: 8,
        includeSuperseded: false,
      }),
    );
    const sampleForLLM = sample.map((s) => ({ id: s.id, content: s.content }));

    // Decide extraction strategy:
    //   (a) Whole episode fits in the LLM context → single call, facts link
    //       to all chunks.
    //   (b) Too big → group chunks into context-sized packs, one call each.
    const chunks = await read((tx) => ChunkRepository.listByEpisode(tx, ep.id));
    const groups = await planExtractionGroups(ep, chunks);

    const newFromThisEp: Fact[] = [];

    for (const group of groups) {
      // Entities seen in this group (normalized name → id/name/type), used as
      // the candidate set for relation extraction once the group's facts land.
      const groupEntities = new Map<string, { id: string; name: string; type: string }>();
      let extracted: Awaited<ReturnType<typeof llm.extractFacts>>;
      try {
        extracted = await llm.extractFacts({
          episode: group.episode,
          existingFacts: sampleForLLM,
        });
      } catch (err) {
        run.extractionFailures += 1;
        logLLMError(
          `[dream ${run.id}] extractFacts failed for episode=${ep.id} (${group.chunkIds.length} chunks), skipping group`,
          err,
        );
        continue;
      }
      if (extracted.length === 0) continue;

      const embeddings = await embedder.embedBatch(extracted.map((e) => e.content));

      for (let i = 0; i < extracted.length; i++) {
        const ext = extracted[i]!;
        const embedding = embeddings[i] ?? [];

        // Skip duplicates within the live fact set. The dedup bucket is the
        // episode's own project bucket, widened (unless the episode is from an
        // isolated project) to the unscoped personal bucket so the same fact
        // learned personally and inside a project doesn't persist twice.
        const similar = await read((tx) =>
          FactRepository.listSimilar(tx, {
            embedding,
            limit: 5,
            includeSuperseded: false,
            scope: {
              projectId: ep.projectId ?? null,
              includeUnscoped: config.crossScopeDedup && !ep.isolated,
              userId: ep.userId ?? null,
            },
          }),
        );
        if (similar.some((s) => cosine(embedding, s.embedding) > config.dedupThreshold)) continue;

        let upsertedEntities: Awaited<ReturnType<typeof EntityRepository.upsertMany>> = [];
        const persisted = await write(async (tx) => {
          // Batched entity upsert — one round trip instead of N.
          const entities = await EntityRepository.upsertMany(
            tx,
            resolveExtractedEntities(ext).map(({ name, type }) => ({ name, type, embedding })),
          );
          upsertedEntities = entities;
          const entityIds = entities.map((e) => e.id);

          const now = new Date();
          const fact: Fact = {
            id: newId(),
            content: ext.content,
            category: ext.category,
            confidence: ext.confidence,
            importance: ext.importance,
            validFrom: now,
            validTo: null,
            recordedAt: now,
            embedding,
            entityIds,
            sourceEpisodeId: ep.id,
            // Inherit the source episode's scope so isolated projects keep
            // their own dream-learned facts and don't leak into other scopes.
            projectId: ep.projectId,
            userId: ep.userId,
          };
          const created = await FactRepository.create(tx, fact, {
            sourceChunkIds: group.chunkIds,
          });
          await recordDreamerEvent(tx, run, {
            kind: 'create',
            targetId: created.id,
            targetKind: 'fact',
            payload: {
              episodeId: ep.id,
              category: created.category,
              confidence: created.confidence,
              importance: created.importance,
            },
          });
          return created;
        });

        for (const e of upsertedEntities) {
          groupEntities.set(e.name.trim().toLowerCase(), { id: e.id, name: e.name, type: e.type });
          touchedEntityIds.add(e.id);
        }
        newFromThisEp.push(persisted);
        run.factsCreated += 1;
      }

      // Relation extraction (OpenIE): build entity↔entity edges among the
      // entities this group surfaced. Best-effort — a failure leaves the facts
      // intact and just skips the triples for this group.
      if (
        config.enableRelationExtraction &&
        typeof llm.extractRelations === 'function' &&
        groupEntities.size >= 2
      ) {
        try {
          const relations = await llm.extractRelations({
            text: group.episode.rawTranscript,
            entities: Array.from(groupEntities.values()).map((e) => ({
              name: e.name,
              type: e.type,
            })),
          });
          const rows = relations
            .filter((r) => r.confidence >= config.relationMinConfidence)
            .map((r) => {
              const s = groupEntities.get(r.subject.trim().toLowerCase());
              const o = groupEntities.get(r.object.trim().toLowerCase());
              if (!s || !o || s.id === o.id) return null;
              return {
                subjectId: s.id,
                objectId: o.id,
                predicate: r.predicate.trim().toLowerCase().replace(/\s+/g, '_'),
                confidence: r.confidence,
                episodeId: ep.id,
              };
            })
            .filter((r): r is NonNullable<typeof r> => r !== null);
          if (rows.length > 0) {
            const created = await write((tx) => EntityRepository.upsertRelations(tx, rows));
            run.relationsCreated += created;
          }
        } catch (err) {
          logLLMError(
            `[dream ${run.id}] extractRelations failed for episode=${ep.id}, skipping group triples`,
            err,
          );
        }
      }
    }

    // Contradiction pass — exclude THIS episode's facts (siblings), allow
    // supersede against any prior fact (including ones from earlier episodes
    // in this same dream cycle).
    const epFactIds = new Set(newFromThisEp.map((f) => f.id));
    for (const fact of newFromThisEp) {
      if (supersededInCycle.has(fact.id)) continue;
      const candidates = await read((tx) =>
        FactRepository.listSimilar(tx, {
          embedding: fact.embedding,
          limit: 8,
          minScore: config.supersedeVectorThreshold,
          includeSuperseded: false,
          // Supersede within this episode's own bucket, or the unscoped
          // personal bucket — never another project's.
          scope: {
            projectId: ep.projectId ?? null,
            includeUnscoped: config.crossScopeDedup && !ep.isolated,
            userId: ep.userId ?? null,
          },
        }),
      );
      const others = candidates.filter((c) => c.id !== fact.id && !epFactIds.has(c.id));
      if (others.length === 0) continue;

      let decision: Awaited<ReturnType<typeof llm.detectSupersede>>;
      try {
        decision = await llm.detectSupersede({
          candidate: { id: fact.id, content: fact.content },
          existing: others.map((o) => ({ id: o.id, content: o.content })),
        });
      } catch (err) {
        run.supersedeFailures += 1;
        logLLMError(
          `[dream ${run.id}] detectSupersede failed for fact=${fact.id} in episode=${ep.id}, skipping`,
          err,
        );
        continue;
      }
      if (!decision) continue;

      await write(async (tx) => {
        const { newConfidence } = await FactRepository.supersede(tx, {
          oldId: decision.oldFactId,
          newId: fact.id,
          reason: decision.reason,
          at: new Date(),
          confidenceDelta: decision.confidenceDelta,
        });
        await recordDreamerEvent(tx, run, {
          kind: 'supersede',
          targetId: decision.oldFactId,
          targetKind: 'fact',
          payload: {
            newFactId: fact.id,
            reason: decision.reason,
            confidenceDelta: decision.confidenceDelta,
            ...(newConfidence !== null ? { newConfidence } : {}),
          },
        });
      });
      supersededInCycle.add(decision.oldFactId);
      run.factsSuperseded += 1;
    }

    return newFromThisEp;
  }

  // Decide how to feed the LLM for one Episode. Always pack chunks greedily
  // into input-bounded groups — never hand a whole transcript over in one
  // shot, because output (JSON facts) scales with input and the model will
  // truncate mid-fact when it produces too many. See EXTRACTION_INPUT_TOKEN_CAP.
  async function planExtractionGroups(
    ep: Episode,
    chunks: Chunk[],
  ): Promise<Array<{ episode: Episode; chunkIds: string[] }>> {
    const contextBudget = Math.min(
      Math.floor(llm.maxContextTokens * EXTRACTION_CONTEXT_USABLE),
      EXTRACTION_INPUT_TOKEN_CAP,
    );

    // Pack chunks greedily into context-sized groups. Guaranteed to make
    // progress because every Chunk is ≤ embedder limit, which is always
    // smaller than a sensible LLM context.
    const groups: Array<{ episode: Episode; chunkIds: string[] }> = [];
    let bufText = '';
    const bufIds: string[] = [];
    let bufTokens = 0;

    function flush(): void {
      if (!bufText) return;
      groups.push({ episode: { ...ep, rawTranscript: bufText }, chunkIds: bufIds.slice() });
      bufText = '';
      bufIds.length = 0;
      bufTokens = 0;
    }

    for (const c of chunks) {
      const nextTokens = c.tokenCount + (bufText ? 2 : 0); // ~ "\n\n" between chunks
      if (bufTokens + nextTokens > contextBudget && bufText) flush();
      bufText = bufText ? `${bufText}\n\n${c.text}` : c.text;
      bufIds.push(c.id);
      bufTokens += nextTokens;
    }
    flush();
    return groups;
  }

  // Re-embed the entities touched this cycle from their NAME (not the first
  // fact's embedding, which was a write-once placeholder), then link semantic
  // duplicates with non-destructive :SYNONYM edges. PageRank later propagates
  // across these edges, so "NYC" and "New York City" share retrieval mass.
  async function resolveEntityGraph(touchedEntityIds: Set<string>, run: DreamRun): Promise<void> {
    if (!config.enableEntityResolution) return;
    const ids = Array.from(touchedEntityIds);
    if (ids.length === 0) return;

    const entities = await read((tx) => EntityRepository.getMany(tx, ids));
    if (entities.length === 0) return;

    const vectors = await embedder.embedBatch(entities.map((e) => e.name));
    const embById = new Map<string, number[]>();
    const rows = entities.map((e, i) => {
      const v = vectors[i] ?? [];
      embById.set(e.id, v);
      return { id: e.id, embedding: v };
    });
    await write((tx) => EntityRepository.setEmbeddings(tx, rows));
    run.entitiesReembedded += rows.length;

    // Collect synonym pairs from two sources:
    //  1. in-app pairwise over this freshly-embedded batch — reliable even
    //     though the entity_vectors index is only eventually consistent;
    //  2. the index, to catch matches against entities from earlier cycles.
    const pairs = new Map<string, { aId: string; bId: string; score: number }>();
    const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        const a = entities[i]!;
        const b = entities[j]!;
        const va = embById.get(a.id);
        const vb = embById.get(b.id);
        if (!va || !vb || va.length === 0 || vb.length === 0) continue;
        const score = cosine(va, vb);
        if (score >= config.synonymThreshold) {
          pairs.set(pairKey(a.id, b.id), { aId: a.id, bId: b.id, score });
        }
      }
    }

    for (const e of entities) {
      const v = embById.get(e.id);
      if (!v || v.length === 0) continue;
      const candidates = await read((tx) =>
        EntityRepository.findSynonymCandidates(tx, {
          entityId: e.id,
          embedding: v,
          threshold: config.synonymThreshold,
          limit: config.synonymCandidates,
        }),
      );
      for (const c of candidates) {
        pairs.set(pairKey(e.id, c.id), { aId: e.id, bId: c.id, score: c.score });
      }
    }

    if (pairs.size > 0) {
      const created = await write((tx) =>
        EntityRepository.addSynonyms(tx, Array.from(pairs.values())),
      );
      run.synonymsCreated += created;
    }
  }

  // Promote highly-important + non-superseded facts to Insights.
  // Note: full promote logic (referenceCount >= 3) is handled in a separate
  // background pass — this cycle only promotes new high-importance facts.
  // Consolidation: merge complementary fragment facts about one entity into a
  // single canonical fact. Entity-anchored (not episode-anchored) on purpose —
  // it backfills fragmentation that already exists in the graph, not just
  // what this cycle created. Budgeted by clusters judged per run and by the
  // cycle deadline; every failure is per-cluster best-effort.
  async function consolidateFactsPass(
    run: DreamRun,
    deadline: number,
    touchedEntityIds: Set<string>,
    supersededInCycle: Set<string>,
  ): Promise<void> {
    if (!config.enableConsolidation) return;
    const consolidate = llm.consolidateFacts?.bind(llm);
    if (!consolidate) return;

    // Entities with enough live facts to plausibly hold fragments. Overfetch
    // beyond the cluster budget so touched-first prioritisation has a pool to
    // pick from; old fragmentation drains over successive nights.
    const candidates = await read(async (tx) => {
      const result = await tx.run(
        `MATCH (e:Entity)-[:HAS_FACT]->(f:Fact)
         WHERE f.validTo IS NULL
         WITH e, count(f) AS liveFacts
         WHERE liveFacts >= $minFacts
         RETURN e.id AS id
         ORDER BY liveFacts DESC, e.id
         LIMIT toInteger($limit)`,
        {
          minFacts: config.consolidationMinEntityFacts,
          limit: config.consolidationMaxClustersPerRun * 5,
        },
      );
      return result.records.map((r) => r.get('id') as string);
    });
    const ordered = [
      ...candidates.filter((id) => touchedEntityIds.has(id)),
      ...candidates.filter((id) => !touchedEntityIds.has(id)),
    ];

    // Facts already folded into a merge this pass — a fact shared by several
    // entities must not be merged twice.
    const consumed = new Set<string>();
    let judged = 0;

    for (const entityId of ordered) {
      if (judged >= config.consolidationMaxClustersPerRun || Date.now() >= deadline) break;

      const facts = await read((tx) => FactRepository.listForEntity(tx, { entityId }));
      const live = facts.filter(
        (f) => f.validTo === null && !consumed.has(f.id) && !supersededInCycle.has(f.id),
      );
      if (live.length < 2) continue;

      const byId = new Map(live.map((f) => [f.id, f]));
      const clusters = clusterForConsolidation(live, {
        minSimilarity: config.consolidationMinSimilarity,
        maxClusterSize: config.consolidationMaxClusterSize,
      });

      for (const clusterIds of clusters) {
        if (judged >= config.consolidationMaxClustersPerRun || Date.now() >= deadline) break;
        const cluster = clusterIds
          .map((id) => byId.get(id))
          .filter((f): f is Fact => f !== undefined && !consumed.has(f.id));
        if (cluster.length < 2) continue;

        judged += 1;
        let decision: Awaited<ReturnType<typeof consolidate>>;
        try {
          decision = await consolidate({
            cluster: cluster.map((f) => ({
              id: f.id,
              content: f.content,
              category: f.category,
              confidence: f.confidence,
              importance: f.importance,
            })),
          });
        } catch (err) {
          logLLMError(
            `[dream ${run.id}] consolidateFacts failed for entity=${entityId}, skipping cluster`,
            err,
          );
          continue;
        }
        if (!decision || decision.decision !== 'merge') continue;

        // Validate the LLM's subset: ids must come from this cluster, unmerged,
        // and at least 2 of them; content must be a plausible single fact.
        const memberIds = [...new Set(decision.mergeFactIds)].filter(
          (id) => byId.has(id) && clusterIds.includes(id) && !consumed.has(id),
        );
        const content = decision.content.trim();
        if (memberIds.length < 2 || content.length === 0 || content.length > 500) continue;
        const members = memberIds.map((id) => byId.get(id)!);

        // A merge is a restatement, not new evidence: confidence stays within
        // the members' band (small bonus for corroboration), importance must
        // not demote below the strongest member.
        const minConf = Math.min(...members.map((m) => m.confidence));
        const maxConf = Math.max(...members.map((m) => m.confidence));
        const confidence = Math.min(
          Math.max(decision.confidence, minConf),
          Math.min(1, maxConf + 0.05),
        );
        const maxImp = Math.max(...members.map((m) => m.importance));
        const importance = Math.min(Math.max(decision.importance, Math.max(0, maxImp - 0.1)), 1);

        const now = new Date();
        const anchor = members[0]!;
        const newFact: Fact = {
          id: newId(),
          content,
          category: decision.category ?? anchor.category,
          confidence,
          importance,
          // The merged claim has been true since its earliest fragment.
          validFrom: new Date(Math.min(...members.map((m) => m.validFrom.getTime()))),
          validTo: null,
          recordedAt: now,
          embedding: await embedder.embed(content),
          entityIds: [...new Set(members.flatMap((m) => m.entityIds))],
          mergedFromFactIds: memberIds,
          // All members share one scope bucket by clustering construction.
          projectId: anchor.projectId,
          userId: anchor.userId,
        };

        const persisted = await write(async (tx) => {
          const created = await FactRepository.mergeFrom(tx, {
            newFact,
            memberIds,
            reason: 'consolidation',
            at: now,
          });
          await recordDreamerEvent(tx, run, {
            kind: 'merge',
            targetId: created.id,
            targetKind: 'fact',
            payload: { mergedFromFactIds: memberIds, entityId },
          });
          return created;
        });
        void persisted;

        for (const id of memberIds) {
          consumed.add(id);
          supersededInCycle.add(id);
        }
        run.factsMerged += 1;
      }
    }
  }

  async function promoteHighImportanceInsights(
    created: Fact[],
    supersededInCycle: Set<string>,
    run: DreamRun,
  ): Promise<void> {
    const promoteCandidates = created.filter(
      (f) => f.importance >= config.promoteInsightImportance && !supersededInCycle.has(f.id),
    );
    for (const f of promoteCandidates) {
      const insight: Insight = {
        id: newId(),
        content: f.content,
        embedding: f.embedding,
        promotedFromFactIds: [f.id],
        createdAt: new Date(),
        // Carry the source fact's scope so insight recall honors isolation.
        projectId: f.projectId,
        userId: f.userId,
      };
      await write(async (tx) => {
        await InsightRepository.create(tx, insight);
        await recordDreamerEvent(tx, run, {
          kind: 'promote',
          targetId: insight.id,
          targetKind: 'insight',
          payload: { fromFactId: f.id, importance: f.importance },
        });
      });
      run.insightsPromoted += 1;
    }
  }

  // Soft-prune low-importance, long-unreferenced facts via the Ebbinghaus curve.
  async function pruneStale(run: DreamRun): Promise<void> {
    const stale = await read(async (tx) => {
      const result = await tx.run(
        `MATCH (f:Fact)
         WHERE f.validTo IS NULL
           AND coalesce(f.lastReferencedAt, f.recordedAt) < datetime() - duration({days: $days})
         RETURN f.id AS id, f.importance AS importance,
                coalesce(f.referenceCount, 0) AS refCount,
                coalesce(f.lastReferencedAt, f.recordedAt) AS lastRef
         LIMIT toInteger($limit)`,
        { days: config.pruneWindowDays, limit: config.pruneBatchLimit },
      );
      return result.records.map((r) => ({
        id: r.get('id') as string,
        importance: r.get('importance') as number,
        refCount: r.get('refCount') as number,
        lastRef: new Date(r.get('lastRef').toString()),
      }));
    });

    for (const s of stale) {
      const days = (Date.now() - s.lastRef.getTime()) / 86_400_000;
      const prune = shouldPrune({
        importance: s.importance,
        daysSinceLastReference: days,
        referenceCount: s.refCount,
        config: {
          importanceExempt: config.pruneImportanceExempt,
          minWindowDays: config.pruneWindowDays,
          retentionFloor: config.pruneRetentionFloor,
        },
      });
      if (!prune) continue;
      await write(async (tx) => {
        await FactRepository.softDelete(tx, s.id, new Date());
        await recordDreamerEvent(tx, run, {
          kind: 'prune',
          targetId: s.id,
          targetKind: 'fact',
          payload: {
            importance: s.importance,
            referenceCount: s.refCount,
            daysSinceLastReference: days,
          },
        });
      });
      run.factsPruned += 1;
    }
  }

  async function finalise(run: DreamRun): Promise<DreamRun> {
    const completed: DreamRun = { ...run, status: 'completed', completedAt: new Date() };
    jobs.set(completed.id, completed);
    await write((tx) => DreamRunRepository.update(tx, completed.id, completed));
    return completed;
  }

  return {
    trigger,
    status,
    runCycle,
    lastCompleted,
    backlogEstimate,
    currentRunningJobId(): string | null {
      return runningJobId;
    },
    currentLastDurationMs(): number | null {
      return lastRunDurationMs;
    },
  };
}

export type DreamingService = ReturnType<typeof createDreamingService>;
