import type { ManagedTransaction } from 'neo4j-driver';
import type { DreamRun, DreamRunStatus } from '../models/types.ts';
import { dateParam, nullableDateParam, toJsDate, toJsDateOrNull } from '../utils/neo4j-conv.ts';

function toDreamRun(node: Record<string, unknown>): DreamRun {
  return {
    id: node.id as string,
    startedAt: toJsDate(node.startedAt),
    completedAt: toJsDateOrNull(node.completedAt),
    status: node.status as DreamRunStatus,
    episodesProcessed: (node.episodesProcessed as number) ?? 0,
    episodesFailed: (node.episodesFailed as number) ?? 0,
    factsCreated: (node.factsCreated as number) ?? 0,
    factsSuperseded: (node.factsSuperseded as number) ?? 0,
    factsPruned: (node.factsPruned as number) ?? 0,
    factsMerged: (node.factsMerged as number) ?? 0,
    insightsPromoted: (node.insightsPromoted as number) ?? 0,
    extractionFailures: (node.extractionFailures as number) ?? 0,
    supersedeFailures: (node.supersedeFailures as number) ?? 0,
    relationsCreated: (node.relationsCreated as number) ?? 0,
    synonymsCreated: (node.synonymsCreated as number) ?? 0,
    entitiesReembedded: (node.entitiesReembedded as number) ?? 0,
    error: (node.error as string | undefined) ?? undefined,
  };
}

export const DreamRunRepository = {
  async create(tx: ManagedTransaction, run: DreamRun): Promise<DreamRun> {
    const result = await tx.run(
      `CREATE (d:DreamRun {
         id: $id,
         startedAt: datetime($startedAt),
         completedAt: CASE WHEN $completedAt IS NULL THEN NULL ELSE datetime($completedAt) END,
         status: $status,
         episodesProcessed: $episodesProcessed,
         episodesFailed: $episodesFailed,
         factsCreated: $factsCreated,
         factsSuperseded: $factsSuperseded,
         factsPruned: $factsPruned,
         factsMerged: $factsMerged,
         insightsPromoted: $insightsPromoted,
         extractionFailures: $extractionFailures,
         supersedeFailures: $supersedeFailures,
         relationsCreated: $relationsCreated,
         synonymsCreated: $synonymsCreated,
         entitiesReembedded: $entitiesReembedded,
         error: $error
       })
       RETURN d {.*} AS d`,
      {
        id: run.id,
        startedAt: dateParam(run.startedAt),
        completedAt: nullableDateParam(run.completedAt),
        status: run.status,
        episodesProcessed: run.episodesProcessed,
        episodesFailed: run.episodesFailed,
        factsCreated: run.factsCreated,
        factsSuperseded: run.factsSuperseded,
        factsPruned: run.factsPruned,
        factsMerged: run.factsMerged,
        insightsPromoted: run.insightsPromoted,
        extractionFailures: run.extractionFailures,
        supersedeFailures: run.supersedeFailures,
        relationsCreated: run.relationsCreated,
        synonymsCreated: run.synonymsCreated,
        entitiesReembedded: run.entitiesReembedded,
        error: run.error ?? null,
      },
    );
    return toDreamRun(result.records[0]!.get('d'));
  },

  async update(
    tx: ManagedTransaction,
    id: string,
    patch: Partial<Omit<DreamRun, 'id' | 'startedAt'>>,
  ): Promise<DreamRun | null> {
    const result = await tx.run(
      `MATCH (d:DreamRun {id: $id})
       SET d.completedAt = CASE
             WHEN $completedAt IS NULL THEN d.completedAt
             ELSE datetime($completedAt)
           END,
           d.status = coalesce($status, d.status),
           d.episodesProcessed = coalesce($episodesProcessed, d.episodesProcessed),
           d.episodesFailed = coalesce($episodesFailed, d.episodesFailed),
           d.factsCreated = coalesce($factsCreated, d.factsCreated),
           d.factsSuperseded = coalesce($factsSuperseded, d.factsSuperseded),
           d.factsPruned = coalesce($factsPruned, d.factsPruned),
           d.factsMerged = coalesce($factsMerged, d.factsMerged),
           d.insightsPromoted = coalesce($insightsPromoted, d.insightsPromoted),
           d.extractionFailures = coalesce($extractionFailures, d.extractionFailures),
           d.supersedeFailures = coalesce($supersedeFailures, d.supersedeFailures),
           d.relationsCreated = coalesce($relationsCreated, d.relationsCreated),
           d.synonymsCreated = coalesce($synonymsCreated, d.synonymsCreated),
           d.entitiesReembedded = coalesce($entitiesReembedded, d.entitiesReembedded),
           d.error = coalesce($error, d.error)
       RETURN d {.*} AS d`,
      {
        id,
        completedAt: nullableDateParam(patch.completedAt ?? null),
        status: patch.status ?? null,
        episodesProcessed: patch.episodesProcessed ?? null,
        episodesFailed: patch.episodesFailed ?? null,
        factsCreated: patch.factsCreated ?? null,
        factsSuperseded: patch.factsSuperseded ?? null,
        factsPruned: patch.factsPruned ?? null,
        factsMerged: patch.factsMerged ?? null,
        insightsPromoted: patch.insightsPromoted ?? null,
        extractionFailures: patch.extractionFailures ?? null,
        supersedeFailures: patch.supersedeFailures ?? null,
        relationsCreated: patch.relationsCreated ?? null,
        synonymsCreated: patch.synonymsCreated ?? null,
        entitiesReembedded: patch.entitiesReembedded ?? null,
        error: patch.error ?? null,
      },
    );
    const record = result.records[0];
    return record ? toDreamRun(record.get('d')) : null;
  },

  async get(tx: ManagedTransaction, id: string): Promise<DreamRun | null> {
    const result = await tx.run('MATCH (d:DreamRun {id: $id}) RETURN d {.*} AS d', { id });
    const record = result.records[0];
    return record ? toDreamRun(record.get('d')) : null;
  },

  async getLastCompleted(tx: ManagedTransaction): Promise<DreamRun | null> {
    const result = await tx.run(
      `MATCH (d:DreamRun {status: 'completed'})
       RETURN d {.*} AS d
       ORDER BY d.completedAt DESC
       LIMIT 1`,
    );
    const record = result.records[0];
    return record ? toDreamRun(record.get('d')) : null;
  },
};
