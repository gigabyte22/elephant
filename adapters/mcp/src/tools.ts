// The elephant tools, per EXPECTED.md §2. /dream is deliberately not a
// tool — consolidation runs on elephant's own cron.

import type { ElephantClient } from '@elephant/client';
import { ElephantError } from '@elephant/client';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpScopeConfig } from './config.ts';
import {
  type TextResult,
  formatDocument,
  formatDocumentLine,
  formatFactLine,
  formatIntention,
  formatProcedure,
  formatRecall,
  formatStateEntry,
  listResult,
  textResult,
} from './format.ts';

// Schema fragments shared by several tools. Kept here so the wording of a
// `describe()` — which the model reads as documentation — can't drift between
// two tools that mean the same thing.
const listLimit = z.number().int().min(1).max(100).optional().describe('default 20');
const auditReason = z
  .string()
  .optional()
  .describe('Why the change was made (kept in the audit log)');

export function registerTools(
  server: McpServer,
  client: ElephantClient,
  scope: McpScopeConfig,
): void {
  server.registerTool(
    'memory_save',
    {
      title: 'Save a fact to long-term memory',
      description:
        'Persist a durable fact (one sentence is best). Facts are embedded, deduplicated against prior beliefs, and consolidated nightly.',
      inputSchema: {
        fact: z.string().min(1).describe('The fact to remember'),
        category: z.string().optional().describe('Optional category, e.g. "work", "preference"'),
        importance: z.number().min(0).max(1).optional().describe('0-1, default 0.6'),
        entities: z.array(z.string()).optional().describe('Named entities this fact is about'),
      },
    },
    async ({ fact, category, importance, entities }) => {
      const saved = await client.saveFact({
        content: fact,
        category,
        importance,
        entityNames: entities,
        agentId: scope.agentId,
        sessionId: scope.sessionId,
        projectId: scope.projectId,
        userId: scope.userId,
        actor: scope.agentId,
      });
      return textResult(`Saved fact ${saved.id}${category ? ` [${category}]` : ''}`);
    },
  );

  server.registerTool(
    'memory_recall',
    {
      title: 'Recall from long-term memory',
      description:
        'Semantic recall over facts, preferences, insights, procedures, knowledge, research, and intentions. Supports temporal and importance filters.',
      inputSchema: {
        query: z.string().min(1).describe('Natural language query'),
        from: z.string().optional().describe('ISO date — only facts valid after this'),
        to: z.string().optional().describe('ISO date — only facts valid before this'),
        minImportance: z.number().min(0).max(1).optional(),
        limit: z.number().int().min(1).max(50).optional().describe('default 10'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, from, to, minImportance, limit }) => {
      const result = await client.recall({
        q: query,
        agentId: scope.agentId,
        sessionId: scope.sessionId,
        projectId: scope.projectId,
        userId: scope.userId,
        agentScope: scope.agentScope,
        sessionScope: scope.sessionScope,
        projectScope: scope.projectId ? scope.projectScope : 'none',
        userScope: scope.userId ? scope.userScope : 'none',
        from: from ? new Date(from) : undefined,
        to: to ? new Date(to) : undefined,
        minImportance,
        limit: limit ?? 10,
        includePreferences: true,
        includeInsights: true,
        includeProcedures: true,
        includeKnowledge: true,
        includeResearch: true,
        includeIntentions: true,
      });
      return textResult(formatRecall(result));
    },
  );

  server.registerTool(
    'memory_forget',
    {
      title: 'Forget a fact',
      description:
        'Soft-delete a fact by id (preferred), or search by query. A fuzzy query never bulk-deletes: unless exactly one fact matches, the candidates are returned so you can call again with factId.',
      inputSchema: {
        factId: z.string().uuid().optional().describe('Exact fact id (preferred)'),
        query: z.string().optional().describe('Match facts to soft-delete'),
      },
    },
    async ({ factId, query }) => {
      if (factId) {
        await client.deleteFact(factId);
        return textResult(`Soft-deleted fact ${factId}. Audit history preserved.`);
      }
      if (!query) return textResult('Provide factId or query.');
      // Hard-filter to this agent's own facts: a fuzzy forget must never
      // land on (let alone delete) another agent's memory.
      const result = await client.recall({
        q: query,
        agentId: scope.agentId,
        agentScope: 'filter',
        kinds: ['fact'],
        limit: 5,
      });
      if (result.facts.length === 0) return textResult('No matching facts.');
      if (result.facts.length === 1) {
        const only = result.facts[0]!;
        await client.deleteFact(only.id);
        return textResult(`Soft-deleted the single match:\n${formatFactLine(only)}`);
      }
      return textResult(
        `Multiple matches — call memory_forget with the factId to delete:\n${result.facts
          .map(formatFactLine)
          .join('\n')}`,
      );
    },
  );

  server.registerTool(
    'memory_timeline',
    {
      title: 'What was believed at a point in time',
      description:
        'Bi-temporal query: facts (optionally about one entity) or a preference value as they were valid at the given instant.',
      inputSchema: {
        at: z.string().describe('ISO timestamp, e.g. 2026-03-01T00:00:00Z'),
        entity: z.string().optional().describe('Entity name to focus on'),
        preferenceKey: z.string().optional().describe('Preference key to read as-of that time'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ at, entity, preferenceKey }) => {
      let entityId: string | undefined;
      if (entity) {
        const { entities } = await client.searchEntities(entity, 1);
        if (entities.length === 0) return textResult(`No entity found matching "${entity}".`);
        entityId = entities[0]!.id;
      }
      const timeline = await client.timeline(new Date(at), { entityId, preferenceKey });
      const parts: string[] = [`Beliefs valid at ${timeline.at}:`];
      if (timeline.preference) {
        parts.push(`Preference ${preferenceKey}: ${timeline.preference.value}`);
      } else if (preferenceKey) {
        parts.push(`Preference ${preferenceKey}: (not set at that time)`);
      }
      parts.push(
        timeline.facts.length ? timeline.facts.map(formatFactLine).join('\n') : '(no facts)',
      );
      return textResult(parts.join('\n'));
    },
  );

  server.registerTool(
    'memory_entity',
    {
      title: 'Look up an entity',
      description:
        'Fuzzy-search entities by name, or fetch one entity with its fact subgraph by id.',
      inputSchema: {
        name: z.string().optional().describe('Entity name (fuzzy match)'),
        id: z.string().uuid().optional().describe('Exact entity id'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ name, id }) => {
      if (id) {
        const { entity, facts } = await client.getEntity(id);
        const lines = [
          `${entity.name} (${entity.type}) [${entity.id}]`,
          ...facts.map(formatFactLine),
        ];
        return textResult(lines.join('\n'));
      }
      if (!name) return textResult('Provide name or id.');
      const { entities } = await client.searchEntities(name, 10);
      return listResult(
        entities,
        `No entities matching "${name}".`,
        (e) => `- ${e.name} (${e.type}) [${e.id}]`,
      );
    },
  );

  server.registerTool(
    'memory_preference_get',
    {
      title: 'Read a preference',
      description: 'Read the active value of a user preference by key.',
      inputSchema: { key: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ key }) =>
      readOrMissing(async () => {
        const pref = await client.getPreference(key);
        return `${pref.key}: ${pref.value} (confidence ${pref.confidence})`;
      }, `Preference "${key}" is not set.`),
  );

  server.registerTool(
    'memory_preference_set',
    {
      title: 'Set a preference',
      description: 'Set a user preference (key/value). The prior value is auto-superseded.',
      inputSchema: {
        key: z.string().min(1),
        value: z.string(),
        confidence: z.number().min(0).max(1).optional(),
      },
    },
    async ({ key, value, confidence }) => {
      const pref = await client.putPreference(key, value, { confidence, actor: scope.agentId });
      return textResult(`Set ${key} = "${value}" (validFrom ${pref.validFrom})`);
    },
  );

  server.registerTool(
    'memory_observe',
    {
      title: 'Note a short-lived observation',
      description:
        'Write a session-scoped working-memory note (expires after ~7 days). Surfaces in the next recall.',
      inputSchema: {
        note: z.string().min(1),
        sessionId: z.string().optional().describe('Override the default session id'),
      },
    },
    async ({ note, sessionId }) => {
      const obs = await client.writeObservation({
        agentId: scope.agentId,
        sessionId: sessionId ?? scope.sessionId,
        content: note,
      });
      return textResult(`Observed (expires ${obs.expiresAt}).`);
    },
  );

  // ─ Knowledge ──

  server.registerTool(
    'memory_knowledge_save',
    {
      title: 'Save a knowledge document',
      description:
        'Ingest a durable reference document (docs, specs, notes). Chunked and embedded so recall can quote it.',
      inputSchema: {
        title: z.string().min(1),
        source: z.string().min(1).describe('Where it came from, e.g. "web", "manual", "repo"'),
        content: z.string().min(1).describe('Full document text'),
        sourceUri: z.string().optional().describe('Canonical URL or path'),
        summary: z.string().optional(),
        tags: z.array(z.string()).optional(),
      },
    },
    async ({ title, source, content, sourceUri, summary, tags }) => {
      const doc = await client.ingestKnowledge({
        title,
        source,
        content,
        sourceUri,
        summary,
        tags,
        scope: { projectId: scope.projectId, userId: scope.userId },
        actor: scope.agentId,
      });
      return textResult(`Saved knowledge document ${doc.id} — ${doc.title}`);
    },
  );

  server.registerTool(
    'memory_knowledge_get',
    {
      title: 'Read a knowledge document',
      description: 'Fetch one knowledge document by id, including its full content.',
      inputSchema: { id: z.string().uuid() },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => textResult(formatDocument(await client.getKnowledge(id))),
  );

  server.registerTool(
    'memory_knowledge_list',
    {
      title: 'List knowledge documents',
      description: 'List knowledge documents in scope, newest first (titles and summaries only).',
      inputSchema: { limit: listLimit },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      const docs = await client.listKnowledge({
        projectId: scope.projectId,
        userId: scope.userId,
        limit: limit ?? 20,
      });
      return listResult(docs, 'No knowledge documents.', formatDocumentLine);
    },
  );

  server.registerTool(
    'memory_knowledge_update',
    {
      title: 'Update a knowledge document',
      description:
        'Patch a knowledge document. The prior revision is archived, so pass a reason when you can.',
      inputSchema: {
        id: z.string().uuid(),
        title: z.string().optional(),
        content: z.string().optional(),
        summary: z.string().optional(),
        tags: z.array(z.string()).optional(),
        reason: auditReason,
      },
    },
    async ({ id, title, content, summary, tags, reason }) => {
      const doc = await client.updateKnowledge(id, {
        title,
        content,
        summary,
        tags,
        reason,
        actor: scope.agentId,
      });
      return textResult(`Updated knowledge document ${doc.id} — ${doc.title}`);
    },
  );

  server.registerTool(
    'memory_knowledge_delete',
    {
      title: 'Delete a knowledge document',
      description:
        'Soft-delete a knowledge document (audit history preserved). Pass purge to remove it permanently.',
      inputSchema: {
        id: z.string().uuid(),
        purge: z.boolean().optional().describe('Hard-delete instead of soft-delete'),
      },
    },
    async ({ id, purge }) => {
      const { chunksDeleted } = await client.deleteKnowledge(id, purge ?? false);
      return textResult(
        `${purge ? 'Purged' : 'Soft-deleted'} knowledge document ${id} (${chunksDeleted} chunks).`,
      );
    },
  );

  // ─ Research ──

  server.registerTool(
    'memory_research_save',
    {
      title: 'Save a research document',
      description:
        'Store project-scoped research output. Requires a configured project id (ELEPHANT_PROJECT_ID).',
      inputSchema: {
        title: z.string().min(1),
        source: z.string().min(1).describe('Where it came from, e.g. "web", "deep-research"'),
        content: z.string().min(1).describe('Full research text'),
        sourceUri: z.string().optional(),
        summary: z.string().optional(),
        tags: z.array(z.string()).optional(),
      },
    },
    async ({ title, source, content, sourceUri, summary, tags }) => {
      const projectId = scope.projectId;
      if (!projectId) return textResult(NO_PROJECT);
      const doc = await client.createResearch({
        title,
        source,
        content,
        sourceUri,
        summary,
        tags,
        projectId,
        userId: scope.userId,
        actor: scope.agentId,
      });
      return textResult(`Saved research ${doc.id} — ${doc.title}`);
    },
  );

  server.registerTool(
    'memory_research_get',
    {
      title: 'Read a research document',
      description: 'Fetch one research document by id, including its full content.',
      inputSchema: { id: z.string().uuid() },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) =>
      textResult(formatDocument(await client.getResearch(id, { projectId: scope.projectId }))),
  );

  server.registerTool(
    'memory_research_list',
    {
      title: 'List research documents',
      description:
        'List research documents for the configured project, newest first. Requires a configured project id.',
      inputSchema: { limit: listLimit },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      const projectId = scope.projectId;
      if (!projectId) return textResult(NO_PROJECT);
      const docs = await client.listResearch({
        projectId,
        userId: scope.userId,
        limit: limit ?? 20,
      });
      return listResult(docs, 'No research documents.', formatDocumentLine);
    },
  );

  server.registerTool(
    'memory_research_update',
    {
      title: 'Update a research document',
      description:
        'Patch a research document. The prior revision is archived, so pass a reason when you can.',
      inputSchema: {
        id: z.string().uuid(),
        title: z.string().optional(),
        content: z.string().optional(),
        summary: z.string().optional(),
        tags: z.array(z.string()).optional(),
        reason: auditReason,
      },
    },
    async ({ id, title, content, summary, tags, reason }) => {
      const doc = await client.updateResearch(
        id,
        { title, content, summary, tags, reason, actor: scope.agentId },
        { projectId: scope.projectId },
      );
      return textResult(`Updated research ${doc.id} — ${doc.title}`);
    },
  );

  server.registerTool(
    'memory_research_delete',
    {
      title: 'Delete a research document',
      description: 'Soft-delete a research document by id. Audit history is preserved.',
      inputSchema: { id: z.string().uuid() },
    },
    async ({ id }) => {
      await client.deleteResearch(id);
      return textResult(`Soft-deleted research ${id}. Audit history preserved.`);
    },
  );

  // ─ Procedures ──

  server.registerTool(
    'memory_procedure_save',
    {
      title: 'Save a procedure',
      description:
        'Record a reusable how-to. whenToUse is what recall matches against, so make it descriptive.',
      inputSchema: {
        name: z.string().min(1).describe('Stable, unique name'),
        content: z.string().min(1).describe('The steps to follow'),
        whenToUse: z.string().min(1).describe('The situation this procedure applies to'),
      },
    },
    async ({ name, content, whenToUse }) => {
      const proc = await client.createProcedure({
        name,
        content,
        whenToUse,
        scope: { projectId: scope.projectId, userId: scope.userId },
        actor: scope.agentId,
      });
      return textResult(`Saved procedure ${proc.id} — ${proc.name} (v${proc.version})`);
    },
  );

  server.registerTool(
    'memory_procedure_get',
    {
      title: 'Read a procedure',
      description: 'Fetch a procedure by id (preferred), or look it up by exact name.',
      inputSchema: {
        id: z.string().uuid().optional().describe('Exact procedure id'),
        name: z.string().optional().describe('Procedure name'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id, name }) => {
      if (id) return textResult(formatProcedure(await client.getProcedure(id)));
      if (!name) return textResult('Provide id or name.');
      const matches = await client.getProcedureByName(name, {
        projectId: scope.projectId,
        userId: scope.userId,
      });
      if (matches.length === 0) return textResult(`No procedure named "${name}".`);
      return textResult(matches.map(formatProcedure).join('\n\n'));
    },
  );

  server.registerTool(
    'memory_procedure_list',
    {
      title: 'List procedures',
      description: 'List procedures in scope with their trigger conditions (no bodies).',
      inputSchema: { limit: listLimit },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      const procs = await client.listProcedures({
        projectId: scope.projectId,
        userId: scope.userId,
        limit: limit ?? 20,
      });
      return listResult(
        procs,
        'No procedures.',
        (p) => `- [${p.id}] ${p.name} (v${p.version}): ${p.whenToUse}`,
      );
    },
  );

  server.registerTool(
    'memory_procedure_update',
    {
      title: 'Update a procedure',
      description:
        'Patch a procedure. Editing content or whenToUse bumps the version and archives the prior revision.',
      inputSchema: {
        id: z.string().uuid(),
        content: z.string().optional(),
        whenToUse: z.string().optional(),
        successRate: z.number().min(0).max(1).optional().describe('0-1, how well it has worked'),
        reason: auditReason,
      },
    },
    async ({ id, content, whenToUse, successRate, reason }) => {
      const proc = await client.updateProcedure(id, {
        content,
        whenToUse,
        successRate,
        reason,
        actor: scope.agentId,
      });
      return textResult(`Updated procedure ${proc.id} — ${proc.name} (v${proc.version})`);
    },
  );

  server.registerTool(
    'memory_procedure_delete',
    {
      title: 'Delete a procedure',
      description: 'Soft-delete a procedure by id. Audit history is preserved.',
      inputSchema: { id: z.string().uuid() },
    },
    async ({ id }) => {
      await client.deleteProcedure(id);
      return textResult(`Soft-deleted procedure ${id}. Audit history preserved.`);
    },
  );

  // ─ Intentions (prospective memory) ──

  server.registerTool(
    'memory_intention_create',
    {
      title: 'Record an intention',
      description:
        'Remember something to do later — a one-off with a due date, or a recurring cron-scheduled item. Surfaces in recall as it comes due.',
      inputSchema: {
        content: z.string().min(1).describe('What should happen'),
        dueAt: z.string().optional().describe('ISO timestamp the intention comes due'),
        triggerHint: z.string().optional().describe('Situation that should surface it instead'),
        recurring: z.boolean().optional(),
        schedule: z.string().optional().describe('Cron expression when recurring'),
        importance: z.number().min(0).max(1).optional().describe('0-1, default 0.6'),
      },
    },
    async ({ content, dueAt, triggerHint, recurring, schedule, importance }) => {
      const intention = await client.createIntention({
        content,
        dueAt,
        triggerHint,
        recurring,
        schedule,
        importance,
        scope: {
          projectId: scope.projectId,
          userId: scope.userId,
          agentId: scope.agentId,
          sessionId: scope.sessionId,
        },
        actor: scope.agentId,
      });
      return textResult(`Recorded intention ${intention.id}${dueAt ? ` due ${dueAt}` : ''}.`);
    },
  );

  server.registerTool(
    'memory_intention_list',
    {
      title: 'List intentions',
      description: 'List intentions for this agent, optionally filtered by status.',
      inputSchema: {
        status: z
          .enum(['pending', 'completed', 'cancelled', 'expired'])
          .optional()
          .describe('default: all'),
        limit: listLimit,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ status, limit }) => {
      const intentions = await client.listIntentions({
        projectId: scope.projectId,
        userId: scope.userId,
        agentId: scope.agentId,
        status,
        limit: limit ?? 20,
      });
      return listResult(intentions, 'No intentions.', formatIntention);
    },
  );

  server.registerTool(
    'memory_intention_due',
    {
      title: 'List due intentions',
      description: 'List pending intentions that are due now (or before a given instant).',
      inputSchema: {
        before: z.string().optional().describe('ISO timestamp — defaults to now'),
        limit: listLimit,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ before, limit }) => {
      const intentions = await client.listDueIntentions({
        projectId: scope.projectId,
        userId: scope.userId,
        agentId: scope.agentId,
        before,
        limit: limit ?? 20,
      });
      return listResult(intentions, 'Nothing due.', formatIntention);
    },
  );

  server.registerTool(
    'memory_intention_complete',
    {
      title: 'Complete an intention',
      description: 'Mark an intention done. Recurring intentions roll forward to their next slot.',
      inputSchema: {
        id: z.string().uuid(),
        reason: z.string().optional().describe('How it was resolved (kept in the audit log)'),
      },
    },
    async ({ id, reason }) => {
      const intention = await client.completeIntention(id, { reason, actor: scope.agentId });
      return textResult(`Completed intention ${id} (status ${intention.status}).`);
    },
  );

  server.registerTool(
    'memory_intention_cancel',
    {
      title: 'Cancel an intention',
      description: 'Cancel an intention that is no longer wanted. Audit history is preserved.',
      inputSchema: {
        id: z.string().uuid(),
        reason: z.string().optional().describe('Why it was dropped (kept in the audit log)'),
      },
    },
    async ({ id, reason }) => {
      const intention = await client.cancelIntention(id, { reason, actor: scope.agentId });
      return textResult(`Cancelled intention ${id} (status ${intention.status}).`);
    },
  );

  server.registerTool(
    'memory_intention_fired',
    {
      title: 'Mark an intention as surfaced',
      description:
        'Record that an intention was surfaced to the user without resolving it. Bumps its fire count.',
      inputSchema: { id: z.string().uuid() },
    },
    async ({ id }) => {
      const intention = await client.markIntentionFired(id, { actor: scope.agentId });
      return textResult(`Marked intention ${id} as fired (${intention.fireCount} times).`);
    },
  );

  // ─ Working state ──

  server.registerTool(
    'memory_state_set',
    {
      title: 'Set a working-state value',
      description:
        'Write a scratchpad key/value for this agent. Scoped to the agent, optionally expiring.',
      inputSchema: {
        key: z.string().min(1),
        value: z.string().describe('Value to store (JSON is fine — it round-trips as given)'),
        ttlSec: z.number().int().min(1).optional().describe('Seconds until it expires'),
      },
    },
    async ({ key, value, ttlSec }) => {
      await client.setState({ scope: stateScope(scope), key, value, ttlSec });
      return textResult(`Set state ${key}${ttlSec ? ` (expires in ${ttlSec}s)` : ''}.`);
    },
  );

  server.registerTool(
    'memory_state_get',
    {
      title: 'Read a working-state value',
      description: 'Read one working-state key for this agent.',
      inputSchema: { key: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ key }) =>
      readOrMissing(
        async () => formatStateEntry(await client.getState(key, stateScope(scope))),
        `State "${key}" is not set.`,
      ),
  );

  server.registerTool(
    'memory_state_list',
    {
      title: 'List working-state values',
      description: "List this agent's working-state entries, optionally filtered by key prefix.",
      inputSchema: { prefix: z.string().optional().describe('Only keys starting with this') },
      annotations: { readOnlyHint: true },
    },
    async ({ prefix }) => {
      const entries = await client.listState({ ...stateScope(scope), prefix });
      return listResult(entries, 'No state entries.', formatStateEntry);
    },
  );

  server.registerTool(
    'memory_state_delete',
    {
      title: 'Delete a working-state value',
      description: 'Remove one working-state key for this agent.',
      inputSchema: { key: z.string().min(1) },
    },
    async ({ key }) => {
      await client.deleteState(key, stateScope(scope));
      return textResult(`Deleted state ${key}.`);
    },
  );

  // ─ Audit ──

  server.registerTool(
    'memory_audit',
    {
      title: 'Read the audit trail',
      description:
        'Show archived revisions and audit events for one memory item — how it changed, when, and by whom.',
      inputSchema: {
        targetId: z.string().uuid().describe('Id of the fact, preference, document, etc.'),
        limit: listLimit,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ targetId, limit }) => {
      const { revisions, events } = await client.audit(targetId, limit ?? 20);
      if (events.length === 0 && revisions.length === 0) {
        return textResult(`No audit history for ${targetId}.`);
      }
      const sections: string[] = [];
      if (events.length) {
        sections.push(
          `Events:\n${events
            .map((e) => `- ${e.at} ${e.kind} (${e.targetKind})${e.actor ? ` by ${e.actor}` : ''}`)
            .join('\n')}`,
        );
      }
      if (revisions.length) {
        sections.push(
          `Revisions:\n${revisions
            .map((r) => `- ${r.archivedAt} ${r.reason}${r.archivedBy ? ` by ${r.archivedBy}` : ''}`)
            .join('\n')}`,
        );
      }
      return textResult(sections.join('\n\n'));
    },
  );
}

const NO_PROJECT =
  'Research is project-scoped and no project id is configured. Set ELEPHANT_PROJECT_ID on the MCP server and retry.';

/**
 * "Not set" is an answer, not a failure — a 404 from a single-key read becomes
 * ordinary text. Every other error still propagates to the MCP error channel.
 */
async function readOrMissing(read: () => Promise<string>, missing: string): Promise<TextResult> {
  try {
    return textResult(await read());
  } catch (err) {
    if (err instanceof ElephantError && err.status === 404) return textResult(missing);
    throw err;
  }
}

/** Working state is always keyed by agent; the other axes narrow it. */
function stateScope(scope: McpScopeConfig): {
  agentId: string;
  sessionId?: string;
  userId?: string;
  projectId?: string;
} {
  return {
    agentId: scope.agentId,
    sessionId: scope.sessionId,
    userId: scope.userId,
    projectId: scope.projectId,
  };
}
