// OpenClaw memory plugin backed by the elephant memory service.
//
// Shape follows the de-facto memory-plugin template (memory-mem0): a default
// export with `kind: "memory"`, TypeBox tool parameters, and lifecycle hooks —
// `before_agent_start` prepends query-conditioned recall to the agent context,
// `agent_end` flushes the turn transcript to elephant as an Episode so the
// nightly dreamer can extract facts. Select it via
// `plugins.slots.memory = "memory-elephant"` in openclaw.json.

import { Type } from '@sinclair/typebox';
import { ElephantClient, ElephantError } from './vendor/client.ts';
import type { RecallResult, WireFact, WirePreference } from './vendor/wire-types.ts';

export interface ElephantPluginConfig {
  url: string;
  token: string;
  agentId: string;
  projectId?: string;
  userId?: string;
  autoRecall: { enabled: boolean; limit: number; minImportance?: number };
  autoCapture: { enabled: boolean };
}

const configSchema = {
  parse(value: unknown): ElephantPluginConfig {
    const raw = (value ?? {}) as Record<string, unknown>;
    const token = typeof raw.token === 'string' ? raw.token : '';
    if (token.length < 8) {
      throw new Error('memory-elephant: config.token is required (min 8 chars)');
    }
    const autoRecall = (raw.autoRecall ?? {}) as Record<string, unknown>;
    const autoCapture = (raw.autoCapture ?? {}) as Record<string, unknown>;
    return {
      url: typeof raw.url === 'string' && raw.url ? raw.url : 'http://127.0.0.1:18790',
      token,
      agentId: typeof raw.agentId === 'string' && raw.agentId ? raw.agentId : 'openclaw',
      projectId: typeof raw.projectId === 'string' ? raw.projectId : undefined,
      userId: typeof raw.userId === 'string' ? raw.userId : undefined,
      autoRecall: {
        enabled: autoRecall.enabled !== false,
        limit: typeof autoRecall.limit === 'number' ? autoRecall.limit : 8,
        minImportance:
          typeof autoRecall.minImportance === 'number' ? autoRecall.minImportance : undefined,
      },
      autoCapture: { enabled: autoCapture.enabled !== false },
    };
  },
};

// ── formatting ──────────────────────────────────────────────────────────────

function formatFactLine(f: WireFact & { score?: number }): string {
  const bits: string[] = [];
  if (f.score !== undefined) bits.push(f.score.toFixed(2));
  if (f.category) bits.push(f.category);
  const meta = bits.length ? ` (${bits.join(', ')})` : '';
  return `- [${f.id}]${meta} ${f.content}`;
}

function formatRecall(r: RecallResult): string {
  const sections: string[] = [];
  const prefs = r.preferences ?? [];
  if (prefs.length) {
    sections.push(
      `Preferences:\n${prefs.map((p: WirePreference) => `- ${p.key}: ${p.value}`).join('\n')}`,
    );
  }
  if (r.facts.length) sections.push(`Facts:\n${r.facts.map(formatFactLine).join('\n')}`);
  if (r.insights?.length) {
    sections.push(`Insights:\n${r.insights.map((i) => `- ${i.content}`).join('\n')}`);
  }
  if (r.procedures?.length) {
    sections.push(
      `Procedures:\n${r.procedures.map((p) => `- ${p.name} (v${p.version}): ${p.whenToUse}`).join('\n')}`,
    );
  }
  return sections.length ? sections.join('\n\n') : 'No matches.';
}

function text(t: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text: t }] };
}

// Ids are interpolated into request paths; require UUID shape at the tool
// boundary so a crafted "id" can't reroute the call (defense in depth — the
// client also URL-encodes path segments).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── event helpers (payload shapes vary across OpenClaw versions) ────────────

function eventSessionId(event: Record<string, unknown>, fallback: string): string {
  for (const key of ['sessionId', 'sessionKey', 'session']) {
    const v = event[key];
    if (typeof v === 'string' && v) return v;
  }
  return fallback;
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === 'object' && block !== null && 'text' in block
          ? String((block as { text: unknown }).text)
          : '',
      )
      .join('\n');
  }
  return '';
}

// ── plugin ──────────────────────────────────────────────────────────────────

export default {
  id: 'memory-elephant',
  name: 'Elephant Memory',
  description:
    'Long-term memory via the elephant service: hybrid GraphRAG recall, bi-temporal facts, preferences, and nightly consolidation on Neo4j',
  kind: 'memory' as const,
  configSchema,

  // biome-ignore lint/suspicious/noExplicitAny: the api object is supplied by the OpenClaw host at load time
  register(api: any) {
    const config = configSchema.parse(api.pluginConfig);
    const client = new ElephantClient({ url: config.url, token: config.token });
    const scope = {
      agentId: config.agentId,
      projectId: config.projectId,
      userId: config.userId,
    };

    // ─ tools ─
    api.registerTool(
      {
        name: 'memory_recall',
        label: 'Recall Memory',
        description:
          'Recall facts, preferences, insights, and procedures from long-term memory. Supports temporal and importance filters.',
        parameters: Type.Object({
          query: Type.String({ description: 'Natural language query' }),
          from: Type.Optional(Type.String({ description: 'ISO date lower bound' })),
          to: Type.Optional(Type.String({ description: 'ISO date upper bound' })),
          minImportance: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
          limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
        }),
        async execute(
          _toolCallId: string,
          params: {
            query: string;
            from?: string;
            to?: string;
            minImportance?: number;
            limit?: number;
          },
        ) {
          const result = await client.recall({
            q: params.query,
            ...scope,
            agentScope: 'boost',
            projectScope: scope.projectId ? 'boost' : 'none',
            userScope: scope.userId ? 'boost' : 'none',
            from: params.from ? new Date(params.from) : undefined,
            to: params.to ? new Date(params.to) : undefined,
            minImportance: params.minImportance,
            limit: params.limit ?? 10,
            includePreferences: true,
            includeInsights: true,
            includeProcedures: true,
          });
          return text(formatRecall(result));
        },
      },
      { name: 'memory_recall' },
    );

    api.registerTool(
      {
        name: 'memory_save',
        label: 'Save Memory',
        description: 'Save a durable fact to long-term memory (one sentence is best).',
        parameters: Type.Object({
          fact: Type.String({ description: 'The fact to remember' }),
          category: Type.Optional(Type.String()),
          importance: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
          entities: Type.Optional(Type.Array(Type.String())),
        }),
        async execute(
          _toolCallId: string,
          params: { fact: string; category?: string; importance?: number; entities?: string[] },
        ) {
          const saved = await client.saveFact({
            content: params.fact,
            category: params.category,
            importance: params.importance,
            entityNames: params.entities,
            ...scope,
            actor: config.agentId,
          });
          return text(`Saved fact ${saved.id}${params.category ? ` [${params.category}]` : ''}`);
        },
      },
      { name: 'memory_save' },
    );

    api.registerTool(
      {
        name: 'memory_forget',
        label: 'Forget Memory',
        description:
          'Soft-delete a fact by id (preferred) or query. A fuzzy query never bulk-deletes.',
        parameters: Type.Object({
          factId: Type.Optional(Type.String({ description: 'Exact fact id (preferred)' })),
          query: Type.Optional(Type.String({ description: 'Match facts to soft-delete' })),
        }),
        async execute(_toolCallId: string, params: { factId?: string; query?: string }) {
          if (params.factId) {
            if (!UUID_RE.test(params.factId)) return text('factId must be a UUID.');
            await client.deleteFact(params.factId);
            return text(`Soft-deleted fact ${params.factId}. Audit history preserved.`);
          }
          if (!params.query) return text('Provide factId or query.');
          // Hard-filter to this agent's own facts: a fuzzy forget must never
          // land on (let alone delete) another agent's memory.
          const result = await client.recall({
            q: params.query,
            agentId: scope.agentId,
            agentScope: 'filter',
            kinds: ['fact'],
            limit: 5,
          });
          if (result.facts.length === 0) return text('No matching facts.');
          if (result.facts.length === 1) {
            const only = result.facts[0]!;
            await client.deleteFact(only.id);
            return text(`Soft-deleted the single match:\n${formatFactLine(only)}`);
          }
          return text(
            `Multiple matches — call memory_forget with the factId to delete:\n${result.facts
              .map(formatFactLine)
              .join('\n')}`,
          );
        },
      },
      { name: 'memory_forget' },
    );

    api.registerTool(
      {
        name: 'memory_timeline',
        label: 'Memory Timeline',
        description:
          'Bi-temporal query: facts (optionally about one entity) or a preference value as valid at a given instant.',
        parameters: Type.Object({
          at: Type.String({ description: 'ISO timestamp' }),
          entity: Type.Optional(Type.String({ description: 'Entity name to focus on' })),
          preferenceKey: Type.Optional(Type.String()),
        }),
        async execute(
          _toolCallId: string,
          params: { at: string; entity?: string; preferenceKey?: string },
        ) {
          let entityId: string | undefined;
          if (params.entity) {
            const { entities } = await client.searchEntities(params.entity, 1);
            if (entities.length === 0) return text(`No entity found matching "${params.entity}".`);
            entityId = entities[0]!.id;
          }
          const timeline = await client.timeline(new Date(params.at), {
            entityId,
            preferenceKey: params.preferenceKey,
          });
          const parts = [`Beliefs valid at ${timeline.at}:`];
          if (timeline.preference) {
            parts.push(`Preference ${params.preferenceKey}: ${timeline.preference.value}`);
          }
          parts.push(
            timeline.facts.length ? timeline.facts.map(formatFactLine).join('\n') : '(no facts)',
          );
          return text(parts.join('\n'));
        },
      },
      { name: 'memory_timeline' },
    );

    api.registerTool(
      {
        name: 'memory_entity',
        label: 'Memory Entity',
        description: 'Fuzzy-search entities by name, or fetch one with its fact subgraph by id.',
        parameters: Type.Object({
          name: Type.Optional(Type.String()),
          id: Type.Optional(Type.String()),
        }),
        async execute(_toolCallId: string, params: { name?: string; id?: string }) {
          if (params.id) {
            if (!UUID_RE.test(params.id)) return text('id must be a UUID.');
            const { entity, facts } = await client.getEntity(params.id);
            return text(
              [`${entity.name} (${entity.type}) [${entity.id}]`, ...facts.map(formatFactLine)].join(
                '\n',
              ),
            );
          }
          if (!params.name) return text('Provide name or id.');
          const { entities } = await client.searchEntities(params.name, 10);
          if (entities.length === 0) return text(`No entities matching "${params.name}".`);
          return text(entities.map((e) => `- ${e.name} (${e.type}) [${e.id}]`).join('\n'));
        },
      },
      { name: 'memory_entity' },
    );

    api.registerTool(
      {
        name: 'memory_preference_get',
        label: 'Get Preference',
        description: 'Read the active value of a user preference by key.',
        parameters: Type.Object({ key: Type.String() }),
        async execute(_toolCallId: string, params: { key: string }) {
          try {
            const pref = await client.getPreference(params.key);
            return text(`${pref.key}: ${pref.value} (confidence ${pref.confidence})`);
          } catch (err) {
            if (err instanceof ElephantError && err.status === 404) {
              return text(`Preference "${params.key}" is not set.`);
            }
            throw err;
          }
        },
      },
      { name: 'memory_preference_get' },
    );

    api.registerTool(
      {
        name: 'memory_preference_set',
        label: 'Set Preference',
        description: 'Set a user preference (key/value). The prior value is auto-superseded.',
        parameters: Type.Object({
          key: Type.String(),
          value: Type.String(),
          confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
        }),
        async execute(
          _toolCallId: string,
          params: { key: string; value: string; confidence?: number },
        ) {
          const pref = await client.putPreference(params.key, params.value, {
            confidence: params.confidence,
            actor: config.agentId,
          });
          return text(`Set ${params.key} = "${params.value}" (validFrom ${pref.validFrom})`);
        },
      },
      { name: 'memory_preference_set' },
    );

    api.registerTool(
      {
        name: 'memory_observe',
        label: 'Observe',
        description:
          'Write a short-lived session-scoped working-memory note (expires after ~7 days).',
        parameters: Type.Object({
          note: Type.String(),
          sessionId: Type.Optional(Type.String()),
        }),
        async execute(_toolCallId: string, params: { note: string; sessionId?: string }) {
          const obs = await client.writeObservation({
            agentId: config.agentId,
            sessionId: params.sessionId ?? `${config.agentId}:default`,
            content: params.note,
          });
          return text(`Observed (expires ${obs.expiresAt}).`);
        },
      },
      { name: 'memory_observe' },
    );

    // ─ auto-recall: inject query-conditioned memory before the agent runs ─
    if (config.autoRecall.enabled) {
      api.on('before_agent_start', async (event: Record<string, unknown>) => {
        const prompt = typeof event.prompt === 'string' ? event.prompt : '';
        if (!prompt.trim()) return;
        try {
          const result = await client.recall(
            {
              q: prompt,
              ...scope,
              sessionId: eventSessionId(event, `${config.agentId}:default`),
              agentScope: 'boost',
              sessionScope: 'boost',
              projectScope: scope.projectId ? 'boost' : 'none',
              userScope: scope.userId ? 'boost' : 'none',
              minImportance: config.autoRecall.minImportance,
              limit: config.autoRecall.limit,
              includePreferences: true,
              includeInsights: true,
              includeProcedures: true,
            },
            { timeoutMs: 5_000, retries: 0 },
          );
          const rendered = formatRecall(result);
          if (rendered === 'No matches.') return;
          return {
            prependContext: `<relevant-memories source="elephant">\n${rendered}\n</relevant-memories>`,
          };
        } catch (err) {
          // Recall must never block the agent.
          console.error('[memory-elephant] auto-recall failed:', (err as Error).message);
        }
      });
    }

    // ─ auto-capture: flush the finished turn as an Episode ─
    if (config.autoCapture.enabled) {
      api.on('agent_end', async (event: Record<string, unknown>) => {
        try {
          const messages = Array.isArray(event.messages) ? event.messages : [];
          const transcript = messages
            .map((m: { role?: string; content?: unknown }) => {
              const body = messageText(m.content);
              if (!body.trim() || body.includes('<relevant-memories')) return '';
              return `${(m.role ?? 'unknown').toUpperCase()}: ${body}`;
            })
            .filter(Boolean)
            .join('\n\n');
          if (transcript.length < 50) return;
          await client.ingestEpisode(
            {
              agentId: typeof event.agentId === 'string' ? event.agentId : config.agentId,
              sessionId: eventSessionId(event, `${config.agentId}:default`),
              rawTranscript: transcript,
              projectId: scope.projectId,
              userId: scope.userId,
            },
            { retries: 1 },
          );
        } catch (err) {
          // Capture is fire-and-forget; elephant's dreamer catches up later.
          console.error('[memory-elephant] auto-capture failed:', (err as Error).message);
        }
      });
    }

    // ─ CLI ─
    api.registerCli(
      // biome-ignore lint/suspicious/noExplicitAny: commander program supplied by the host
      ({ program }: { program: any }) => {
        const cmd = program.command('elephant').description('Elephant memory service');
        cmd
          .command('status')
          .description('Elephant service health')
          .action(async () => {
            const health = await client.health();
            console.log(JSON.stringify(health, null, 2));
          });
        cmd
          .command('recall <query...>')
          .description('Search long-term memory')
          .action(async (query: string[]) => {
            const result = await client.recall({
              q: query.join(' '),
              ...scope,
              includePreferences: true,
              includeInsights: true,
            });
            console.log(formatRecall(result));
          });
        cmd
          .command('save <fact...>')
          .description('Save a fact')
          .action(async (fact: string[]) => {
            const saved = await client.saveFact({
              content: fact.join(' '),
              ...scope,
              actor: `${config.agentId}:cli`,
            });
            console.log(`Saved fact ${saved.id}`);
          });
        cmd
          .command('forget <id>')
          .description('Soft-delete a fact by id')
          .action(async (id: string) => {
            await client.deleteFact(id);
            console.log(`Soft-deleted fact ${id}`);
          });
        cmd
          .command('prefs')
          .description('List active preferences')
          .action(async () => {
            const { preferences } = await client.listPreferences();
            for (const p of preferences) console.log(`${p.key}: ${p.value}`);
          });
        cmd
          .command('dream')
          .description('Trigger a consolidation cycle')
          .action(async () => {
            const { jobId } = await client.triggerDream();
            console.log(`Dream triggered, job ${jobId}`);
          });
      },
      { commands: ['elephant'] },
    );
  },
};
