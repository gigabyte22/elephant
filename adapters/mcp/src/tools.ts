// The eight elephant tools, per EXPECTED.md §2. /dream is deliberately not a
// tool — consolidation runs on elephant's own cron.

import type { ElephantClient } from '@elephant/client';
import { ElephantError } from '@elephant/client';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpScopeConfig } from './config.ts';
import { formatFactLine, formatRecall, textResult } from './format.ts';

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
        'Semantic recall over facts, preferences, insights, and procedures. Supports temporal and importance filters.',
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
        factId: z.string().optional().describe('Exact fact id (preferred)'),
        query: z.string().optional().describe('Match facts to soft-delete'),
      },
    },
    async ({ factId, query }) => {
      if (factId) {
        await client.deleteFact(factId);
        return textResult(`Soft-deleted fact ${factId}. Audit history preserved.`);
      }
      if (!query) return textResult('Provide factId or query.');
      const result = await client.recall({
        q: query,
        agentId: scope.agentId,
        agentScope: scope.agentScope,
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
        id: z.string().optional().describe('Exact entity id'),
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
      if (entities.length === 0) return textResult(`No entities matching "${name}".`);
      return textResult(entities.map((e) => `- ${e.name} (${e.type}) [${e.id}]`).join('\n'));
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
    async ({ key }) => {
      try {
        const pref = await client.getPreference(key);
        return textResult(`${pref.key}: ${pref.value} (confidence ${pref.confidence})`);
      } catch (err) {
        if (err instanceof ElephantError && err.status === 404) {
          return textResult(`Preference "${key}" is not set.`);
        }
        throw err;
      }
    },
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
}
