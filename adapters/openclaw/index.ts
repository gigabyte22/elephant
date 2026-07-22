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
import type {
  RecallResult,
  WireFact,
  WireIntention,
  WireKnowledgeDocument,
  WirePreference,
  WireProcedure,
  WireWorkingStateEntry,
} from './vendor/wire-types.ts';

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

// Chunk bodies can be arbitrarily long; recall renders into a prompt, so cap
// them rather than letting one document crowd out every other section.
const CHUNK_CHARS = 300;

function formatChunkLine(id: string, body: string): string {
  return `- [${id}] ${body.slice(0, CHUNK_CHARS)}`;
}

function formatDocLine(d: WireKnowledgeDocument): string {
  const tags = d.tags?.length ? ` {${d.tags.join(', ')}}` : '';
  return `- [${d.id}] ${d.title} (${d.source})${tags}${d.summary ? ` — ${d.summary}` : ''}`;
}

/** Header line plus full body — how both knowledge and research render a single
 *  document, in tools and on the CLI. */
function formatDocDetail(d: WireKnowledgeDocument): string {
  return [formatDocLine(d), d.content ?? '(no content)'].join('\n\n');
}

function formatProcedureLine(p: WireProcedure): string {
  return `- [${p.id}] ${p.name} (v${p.version}): ${p.whenToUse}`;
}

function formatIntentionLine(i: WireIntention): string {
  const bits: string[] = [i.status];
  if (i.dueAt) bits.push(`due ${i.dueAt}`);
  if (i.recurring) bits.push('recurring');
  return `- [${i.id}] (${bits.join(', ')}) ${i.content}`;
}

function formatStateLine(e: WireWorkingStateEntry): string {
  const expiry = e.expiresAt ? ` (expires ${e.expiresAt})` : '';
  return `- ${e.key} = ${JSON.stringify(e.value)}${expiry}`;
}

/** A titled block, or null when there is nothing to show — empty sections are
 *  dropped rather than rendered as a bare heading. */
function section<T>(
  title: string,
  items: readonly T[] | undefined,
  format: (item: T) => string,
): string | null {
  if (!items?.length) return null;
  return `${title}:\n${items.map(format).join('\n')}`;
}

function joinSections(sections: Array<string | null>): string {
  return sections.filter((s): s is string => s !== null).join('\n\n');
}

function formatRecall(r: RecallResult): string {
  const rendered = joinSections([
    section('Preferences', r.preferences, (p: WirePreference) => `- ${p.key}: ${p.value}`),
    section('Facts', r.facts, formatFactLine),
    section('Insights', r.insights, (i) => `- ${i.content}`),
    section('Procedures', r.procedures, formatProcedureLine),
    section('Knowledge', r.knowledgeChunks, (k) => formatChunkLine(k.documentId, k.text)),
    section('Research', r.research, formatDocLine),
    section('Research excerpts', r.researchChunks, (c) => formatChunkLine(c.researchId, c.text)),
    section('Intentions', r.intentions, formatIntentionLine),
  ]);
  return rendered || 'No matches.';
}

function text(t: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text: t }] };
}

// Ids are interpolated into request paths; require UUID shape at the tool
// boundary so a crafted "id" can't reroute the call (defense in depth — the
// client also URL-encodes path segments).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The CLI surfaces the same guard as a thrown error; tools return it as text.
function assertUuid(value: string, field = 'id'): void {
  if (!UUID_RE.test(value)) throw new Error(`${field} must be a UUID.`);
}

// ── shared parameter fragments ──────────────────────────────────────────────
// TypeBox schemas are inert JSON, so sharing one object across tools keeps the
// advertised schemas identical by construction rather than by copy-paste.

const idParam = Type.String();
const listLimitParam = Type.Optional(Type.Number({ minimum: 1, maximum: 200 }));
const unitIntervalParam = Type.Optional(Type.Number({ minimum: 0, maximum: 1 }));

/** Knowledge and research revise through the same audited patch shape. */
const docPatchParams = Type.Object({
  id: idParam,
  title: Type.Optional(Type.String()),
  content: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(Type.String())),
  reason: Type.Optional(Type.String()),
});

interface DocPatchParams {
  id: string;
  title?: string;
  content?: string;
  summary?: string;
  tags?: string[];
  reason?: string;
}

/** Every intention lifecycle transition takes an id and an optional reason. */
const idReasonParams = Type.Object({ id: idParam, reason: Type.Optional(Type.String()) });

interface IdReasonParams {
  id: string;
  reason?: string;
}

// The v1.2 knowledge/procedure/research/intention sources early-return unless
// the caller opts in, so every recall path has to ask for them explicitly.
// Declared once: three call sites (tool, auto-recall hook, CLI) silently
// drifted apart when these were inlined.
const RECALL_CATEGORIES = {
  includePreferences: true,
  includeInsights: true,
  includeProcedures: true,
  includeKnowledge: true,
  includeResearch: true,
  includeIntentions: true,
} as const;

const DEFAULT_RECALL_LIMIT = 10;

// Research is project-scoped end-to-end: POST /research rejects a missing
// projectId and GET scopes the read by it. Say so here instead of round-tripping
// a request that can only 400.
const NEEDS_PROJECT =
  'Research is project-scoped: set `projectId` in the memory-elephant plugin config first.';

// POST /intentions rejects an intention with no way to ever surface (no due
// time, no trigger hint, no schedule). Say so here rather than round-tripping a
// request that can only 400 — the model gets an actionable instruction instead
// of a raw server error.
const NEEDS_TRIGGER =
  'An intention needs at least one of `dueAt`, `triggerHint`, or `schedule` — otherwise nothing could ever surface it.';

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
    // Stamped on writes, and the boost axes at recall. Working state and
    // intentions reuse it as-is: both require `agentId`, which is always set,
    // and project/user narrow them further when configured.
    const scope = {
      agentId: config.agentId,
      projectId: config.projectId,
      userId: config.userId,
    };
    // Knowledge, research, and procedures are filed by project/user only —
    // they are shared artifacts, not one agent's memory.
    const docScope = { projectId: config.projectId, userId: config.userId };
    // Scope modes are shared by every recall call site so tool, hook, and CLI
    // results rank identically. `none` where the id is unset: boosting on a
    // missing axis is a no-op that still costs a scoring pass.
    const scopeModes = {
      agentScope: 'boost',
      sessionScope: 'boost',
      projectScope: scope.projectId ? 'boost' : 'none',
      userScope: scope.userId ? 'boost' : 'none',
    } as const;

    // ─ tools ─
    api.registerTool(
      {
        name: 'memory_recall',
        label: 'Recall Memory',
        description:
          'Recall facts, preferences, insights, procedures, knowledge, research, and intentions from long-term memory. Supports temporal and importance filters.',
        parameters: Type.Object({
          query: Type.String({ description: 'Natural language query' }),
          from: Type.Optional(Type.String({ description: 'ISO date lower bound' })),
          to: Type.Optional(Type.String({ description: 'ISO date upper bound' })),
          minImportance: unitIntervalParam,
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
            ...scopeModes,
            ...RECALL_CATEGORIES,
            from: params.from ? new Date(params.from) : undefined,
            to: params.to ? new Date(params.to) : undefined,
            minImportance: params.minImportance,
            limit: params.limit ?? DEFAULT_RECALL_LIMIT,
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
          importance: unitIntervalParam,
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
          confidence: unitIntervalParam,
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

    // ─ knowledge documents ─
    api.registerTool(
      {
        name: 'memory_knowledge_save',
        label: 'Save Knowledge',
        description:
          'Ingest a knowledge document (chunked and embedded for recall). Use for durable reference material, not conversational facts.',
        parameters: Type.Object({
          title: Type.String(),
          source: Type.String({ description: 'Where this came from, e.g. "handbook" or a URL' }),
          content: Type.String(),
          sourceUri: Type.Optional(Type.String()),
          summary: Type.Optional(Type.String()),
          tags: Type.Optional(Type.Array(Type.String())),
        }),
        async execute(
          _toolCallId: string,
          params: {
            title: string;
            source: string;
            content: string;
            sourceUri?: string;
            summary?: string;
            tags?: string[];
          },
        ) {
          const doc = await client.ingestKnowledge({
            ...params,
            scope: docScope,
            actor: config.agentId,
          });
          return text(`Saved knowledge document ${doc.id} — ${doc.title}`);
        },
      },
      { name: 'memory_knowledge_save' },
    );

    api.registerTool(
      {
        name: 'memory_knowledge_get',
        label: 'Get Knowledge',
        description: 'Fetch one knowledge document with its full content by id.',
        parameters: Type.Object({ id: idParam }),
        async execute(_toolCallId: string, params: { id: string }) {
          if (!UUID_RE.test(params.id)) return text('id must be a UUID.');
          return text(formatDocDetail(await client.getKnowledge(params.id)));
        },
      },
      { name: 'memory_knowledge_get' },
    );

    api.registerTool(
      {
        name: 'memory_knowledge_list',
        label: 'List Knowledge',
        description: 'List knowledge documents in the configured scope (titles and summaries).',
        parameters: Type.Object({ limit: listLimitParam }),
        async execute(_toolCallId: string, params: { limit?: number }) {
          const docs = await client.listKnowledge({ ...docScope, limit: params.limit });
          if (docs.length === 0) return text('No knowledge documents.');
          return text(docs.map(formatDocLine).join('\n'));
        },
      },
      { name: 'memory_knowledge_list' },
    );

    api.registerTool(
      {
        name: 'memory_knowledge_update',
        label: 'Update Knowledge',
        description: 'Revise a knowledge document by id. The prior revision is archived.',
        parameters: docPatchParams,
        async execute(_toolCallId: string, params: DocPatchParams) {
          if (!UUID_RE.test(params.id)) return text('id must be a UUID.');
          const { id, ...patch } = params;
          const doc = await client.updateKnowledge(id, { ...patch, actor: config.agentId });
          return text(`Updated knowledge document ${doc.id} — ${doc.title}`);
        },
      },
      { name: 'memory_knowledge_update' },
    );

    api.registerTool(
      {
        name: 'memory_knowledge_delete',
        label: 'Delete Knowledge',
        description: 'Soft-delete a knowledge document by id. Audit history is preserved.',
        parameters: Type.Object({
          id: idParam,
          purge: Type.Optional(Type.Boolean({ description: 'Also drop stored chunks' })),
        }),
        async execute(_toolCallId: string, params: { id: string; purge?: boolean }) {
          if (!UUID_RE.test(params.id)) return text('id must be a UUID.');
          const { chunksDeleted } = await client.deleteKnowledge(params.id, params.purge ?? false);
          return text(`Soft-deleted knowledge document ${params.id} (${chunksDeleted} chunks).`);
        },
      },
      { name: 'memory_knowledge_delete' },
    );

    // ─ research ─
    api.registerTool(
      {
        name: 'memory_research_save',
        label: 'Save Research',
        description: 'Store a research document (project-scoped). Requires a configured projectId.',
        parameters: Type.Object({
          title: Type.String(),
          source: Type.String({ description: 'Where this came from, e.g. a URL' }),
          content: Type.String(),
        }),
        async execute(
          _toolCallId: string,
          params: { title: string; source: string; content: string },
        ) {
          if (!config.projectId) return text(NEEDS_PROJECT);
          const doc = await client.createResearch({
            ...params,
            projectId: config.projectId,
            userId: config.userId,
            actor: config.agentId,
          });
          return text(`Saved research ${doc.id} — ${doc.title}`);
        },
      },
      { name: 'memory_research_save' },
    );

    api.registerTool(
      {
        name: 'memory_research_get',
        label: 'Get Research',
        description: 'Fetch one research document with its full content by id.',
        parameters: Type.Object({ id: idParam }),
        async execute(_toolCallId: string, params: { id: string }) {
          if (!UUID_RE.test(params.id)) return text('id must be a UUID.');
          if (!config.projectId) return text(NEEDS_PROJECT);
          return text(
            formatDocDetail(await client.getResearch(params.id, { projectId: config.projectId })),
          );
        },
      },
      { name: 'memory_research_get' },
    );

    api.registerTool(
      {
        name: 'memory_research_list',
        label: 'List Research',
        description: 'List research documents for the configured project.',
        parameters: Type.Object({ limit: listLimitParam }),
        async execute(_toolCallId: string, params: { limit?: number }) {
          if (!config.projectId) return text(NEEDS_PROJECT);
          const docs = await client.listResearch({
            ...docScope,
            projectId: config.projectId,
            limit: params.limit,
          });
          if (docs.length === 0) return text('No research documents.');
          return text(docs.map(formatDocLine).join('\n'));
        },
      },
      { name: 'memory_research_list' },
    );

    api.registerTool(
      {
        name: 'memory_research_update',
        label: 'Update Research',
        description: 'Revise a research document by id. The prior revision is archived.',
        parameters: docPatchParams,
        async execute(_toolCallId: string, params: DocPatchParams) {
          if (!UUID_RE.test(params.id)) return text('id must be a UUID.');
          if (!config.projectId) return text(NEEDS_PROJECT);
          const { id, ...patch } = params;
          const doc = await client.updateResearch(
            id,
            { ...patch, actor: config.agentId },
            { projectId: config.projectId },
          );
          return text(`Updated research ${doc.id} — ${doc.title}`);
        },
      },
      { name: 'memory_research_update' },
    );

    api.registerTool(
      {
        name: 'memory_research_delete',
        label: 'Delete Research',
        description: 'Soft-delete a research document by id. Audit history is preserved.',
        parameters: Type.Object({ id: idParam }),
        async execute(_toolCallId: string, params: { id: string }) {
          if (!UUID_RE.test(params.id)) return text('id must be a UUID.');
          await client.deleteResearch(params.id);
          return text(`Soft-deleted research ${params.id}. Audit history preserved.`);
        },
      },
      { name: 'memory_research_delete' },
    );

    // ─ procedures ─
    api.registerTool(
      {
        name: 'memory_procedure_save',
        label: 'Save Procedure',
        description:
          'Store a reusable procedure — how to do something, plus when it applies. Surfaced by recall.',
        parameters: Type.Object({
          name: Type.String(),
          content: Type.String({ description: 'The steps' }),
          whenToUse: Type.String({ description: 'Trigger conditions for this procedure' }),
        }),
        async execute(
          _toolCallId: string,
          params: { name: string; content: string; whenToUse: string },
        ) {
          const proc = await client.createProcedure({
            ...params,
            scope: docScope,
            actor: config.agentId,
          });
          return text(`Saved procedure ${proc.id} — ${proc.name} (v${proc.version})`);
        },
      },
      { name: 'memory_procedure_save' },
    );

    api.registerTool(
      {
        name: 'memory_procedure_get',
        label: 'Get Procedure',
        description: 'Fetch a procedure with its steps, by id or by name.',
        parameters: Type.Object({
          id: Type.Optional(Type.String()),
          name: Type.Optional(Type.String()),
        }),
        async execute(_toolCallId: string, params: { id?: string; name?: string }) {
          if (params.id) {
            if (!UUID_RE.test(params.id)) return text('id must be a UUID.');
            const proc = await client.getProcedure(params.id);
            return text([formatProcedureLine(proc), proc.content].join('\n\n'));
          }
          if (!params.name) return text('Provide id or name.');
          const matches = await client.getProcedureByName(params.name, docScope);
          if (matches.length === 0) return text(`No procedure named "${params.name}".`);
          return text(
            matches.map((p) => [formatProcedureLine(p), p.content].join('\n')).join('\n\n'),
          );
        },
      },
      { name: 'memory_procedure_get' },
    );

    api.registerTool(
      {
        name: 'memory_procedure_list',
        label: 'List Procedures',
        description: 'List procedures in the configured scope.',
        parameters: Type.Object({ limit: listLimitParam }),
        async execute(_toolCallId: string, params: { limit?: number }) {
          const procs = await client.listProcedures({ ...docScope, limit: params.limit });
          if (procs.length === 0) return text('No procedures.');
          return text(procs.map(formatProcedureLine).join('\n'));
        },
      },
      { name: 'memory_procedure_list' },
    );

    api.registerTool(
      {
        name: 'memory_procedure_update',
        label: 'Update Procedure',
        description: 'Revise a procedure by id, or record its observed success rate.',
        parameters: Type.Object({
          id: idParam,
          content: Type.Optional(Type.String()),
          whenToUse: Type.Optional(Type.String()),
          successRate: unitIntervalParam,
          reason: Type.Optional(Type.String()),
        }),
        async execute(
          _toolCallId: string,
          params: {
            id: string;
            content?: string;
            whenToUse?: string;
            successRate?: number;
            reason?: string;
          },
        ) {
          if (!UUID_RE.test(params.id)) return text('id must be a UUID.');
          const { id, ...patch } = params;
          const proc = await client.updateProcedure(id, { ...patch, actor: config.agentId });
          return text(`Updated procedure ${proc.id} — ${proc.name} (v${proc.version})`);
        },
      },
      { name: 'memory_procedure_update' },
    );

    api.registerTool(
      {
        name: 'memory_procedure_delete',
        label: 'Delete Procedure',
        description: 'Soft-delete a procedure by id. Audit history is preserved.',
        parameters: Type.Object({ id: idParam }),
        async execute(_toolCallId: string, params: { id: string }) {
          if (!UUID_RE.test(params.id)) return text('id must be a UUID.');
          await client.deleteProcedure(params.id);
          return text(`Soft-deleted procedure ${params.id}. Audit history preserved.`);
        },
      },
      { name: 'memory_procedure_delete' },
    );

    // ─ intentions (prospective memory) ─
    api.registerTool(
      {
        name: 'memory_intention_create',
        label: 'Create Intention',
        description:
          'Record something to do later. Requires at least one of dueAt, triggerHint, or schedule so the intention can resurface.',
        parameters: Type.Object({
          content: Type.String({ description: 'What should happen' }),
          dueAt: Type.Optional(Type.String({ description: 'ISO timestamp' })),
          triggerHint: Type.Optional(
            Type.String({ description: 'Context that should surface this' }),
          ),
          recurring: Type.Optional(Type.Boolean()),
          schedule: Type.Optional(Type.String({ description: 'Cron expression when recurring' })),
          importance: unitIntervalParam,
        }),
        async execute(
          _toolCallId: string,
          params: {
            content: string;
            dueAt?: string;
            triggerHint?: string;
            recurring?: boolean;
            schedule?: string;
            importance?: number;
          },
        ) {
          if (!params.dueAt && !params.triggerHint && !params.schedule) return text(NEEDS_TRIGGER);
          const intention = await client.createIntention({
            ...params,
            scope,
            actor: config.agentId,
          });
          return text(
            `Created intention ${intention.id}${params.dueAt ? ` due ${params.dueAt}` : ''}`,
          );
        },
      },
      { name: 'memory_intention_create' },
    );

    api.registerTool(
      {
        name: 'memory_intention_list',
        label: 'List Intentions',
        description: 'List intentions in the configured scope, optionally filtered by status.',
        parameters: Type.Object({
          status: Type.Optional(
            Type.Union([
              Type.Literal('pending'),
              Type.Literal('completed'),
              Type.Literal('cancelled'),
              Type.Literal('expired'),
            ]),
          ),
          limit: listLimitParam,
        }),
        async execute(
          _toolCallId: string,
          params: { status?: 'pending' | 'completed' | 'cancelled' | 'expired'; limit?: number },
        ) {
          const intentions = await client.listIntentions({ ...scope, ...params });
          if (intentions.length === 0) return text('No intentions.');
          return text(intentions.map(formatIntentionLine).join('\n'));
        },
      },
      { name: 'memory_intention_list' },
    );

    api.registerTool(
      {
        name: 'memory_intention_due',
        label: 'Due Intentions',
        description: 'List intentions that are due now (or before a given instant).',
        parameters: Type.Object({
          before: Type.Optional(Type.String({ description: 'ISO timestamp; defaults to now' })),
          limit: listLimitParam,
        }),
        async execute(_toolCallId: string, params: { before?: string; limit?: number }) {
          const intentions = await client.listDueIntentions({ ...scope, ...params });
          if (intentions.length === 0) return text('Nothing due.');
          return text(intentions.map(formatIntentionLine).join('\n'));
        },
      },
      { name: 'memory_intention_due' },
    );

    api.registerTool(
      {
        name: 'memory_intention_complete',
        label: 'Complete Intention',
        description: 'Mark an intention done.',
        parameters: idReasonParams,
        async execute(_toolCallId: string, params: IdReasonParams) {
          if (!UUID_RE.test(params.id)) return text('id must be a UUID.');
          const intention = await client.completeIntention(params.id, {
            actor: config.agentId,
            reason: params.reason,
          });
          return text(`Completed intention ${intention.id}.`);
        },
      },
      { name: 'memory_intention_complete' },
    );

    api.registerTool(
      {
        name: 'memory_intention_cancel',
        label: 'Cancel Intention',
        description: 'Cancel an intention that is no longer wanted.',
        parameters: idReasonParams,
        async execute(_toolCallId: string, params: IdReasonParams) {
          if (!UUID_RE.test(params.id)) return text('id must be a UUID.');
          const intention = await client.cancelIntention(params.id, {
            actor: config.agentId,
            reason: params.reason,
          });
          return text(`Cancelled intention ${intention.id}.`);
        },
      },
      { name: 'memory_intention_cancel' },
    );

    api.registerTool(
      {
        name: 'memory_intention_fired',
        label: 'Mark Intention Fired',
        description:
          'Record that an intention surfaced to the user. Recurring intentions stay pending.',
        parameters: idReasonParams,
        async execute(_toolCallId: string, params: IdReasonParams) {
          if (!UUID_RE.test(params.id)) return text('id must be a UUID.');
          const intention = await client.markIntentionFired(params.id, {
            actor: config.agentId,
            reason: params.reason,
          });
          return text(`Marked intention ${intention.id} fired (${intention.fireCount} total).`);
        },
      },
      { name: 'memory_intention_fired' },
    );

    // ─ working state ─
    api.registerTool(
      {
        name: 'memory_state_set',
        label: 'Set State',
        description:
          'Write a key to agent working state. Ephemeral scratch space, not long-term memory.',
        parameters: Type.Object({
          key: Type.String(),
          value: Type.Unknown({ description: 'Any JSON value' }),
          ttlSec: Type.Optional(Type.Number({ minimum: 1 })),
        }),
        async execute(
          _toolCallId: string,
          params: { key: string; value: unknown; ttlSec?: number },
        ) {
          await client.setState({ scope, ...params });
          return text(`Set state ${params.key}.`);
        },
      },
      { name: 'memory_state_set' },
    );

    api.registerTool(
      {
        name: 'memory_state_get',
        label: 'Get State',
        description: 'Read one working-state key.',
        parameters: Type.Object({ key: Type.String() }),
        async execute(_toolCallId: string, params: { key: string }) {
          try {
            const entry = await client.getState(params.key, scope);
            return text(formatStateLine(entry));
          } catch (err) {
            if (err instanceof ElephantError && err.status === 404) {
              return text(`State "${params.key}" is not set.`);
            }
            throw err;
          }
        },
      },
      { name: 'memory_state_get' },
    );

    api.registerTool(
      {
        name: 'memory_state_list',
        label: 'List State',
        description: 'List working-state entries, optionally filtered by key prefix.',
        parameters: Type.Object({ prefix: Type.Optional(Type.String()) }),
        async execute(_toolCallId: string, params: { prefix?: string }) {
          const entries = await client.listState({ ...scope, prefix: params.prefix });
          if (entries.length === 0) return text('No state entries.');
          return text(entries.map(formatStateLine).join('\n'));
        },
      },
      { name: 'memory_state_list' },
    );

    api.registerTool(
      {
        name: 'memory_state_delete',
        label: 'Delete State',
        description: 'Delete one working-state key.',
        parameters: Type.Object({ key: Type.String() }),
        async execute(_toolCallId: string, params: { key: string }) {
          await client.deleteState(params.key, scope);
          return text(`Deleted state ${params.key}.`);
        },
      },
      { name: 'memory_state_delete' },
    );

    // ─ audit ─
    api.registerTool(
      {
        name: 'memory_audit',
        label: 'Audit History',
        description:
          'Revision history and audit events for one memory item (fact, preference, procedure, knowledge, or research) by id.',
        parameters: Type.Object({ targetId: Type.String(), limit: listLimitParam }),
        async execute(_toolCallId: string, params: { targetId: string; limit?: number }) {
          if (!UUID_RE.test(params.targetId)) return text('targetId must be a UUID.');
          const { revisions, events } = await client.audit(params.targetId, params.limit);
          if (events.length === 0 && revisions.length === 0) {
            return text(`No audit history for ${params.targetId}.`);
          }
          return text(
            joinSections([
              section(
                'Events',
                events,
                (e) => `- ${e.at} ${e.kind}${e.actor ? ` by ${e.actor}` : ''}`,
              ),
              section(
                'Revisions',
                revisions,
                (r) => `- ${r.archivedAt} ${r.originalKind}: ${r.reason}`,
              ),
            ]),
          );
        },
      },
      { name: 'memory_audit' },
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
              ...scopeModes,
              ...RECALL_CATEGORIES,
              minImportance: config.autoRecall.minImportance,
              limit: config.autoRecall.limit,
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
          .description('Search facts, preferences, insights, procedures, knowledge, and research')
          .action(async (query: string[]) => {
            const result = await client.recall({
              q: query.join(' '),
              ...scope,
              ...scopeModes,
              ...RECALL_CATEGORIES,
              limit: DEFAULT_RECALL_LIMIT,
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
            assertUuid(id);
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

        const knowledge = cmd.command('knowledge').description('Knowledge documents');
        knowledge
          .command('list')
          .description('List knowledge documents')
          .action(async () => {
            const docs = await client.listKnowledge(docScope);
            for (const d of docs) console.log(formatDocLine(d));
          });
        knowledge
          .command('get <id>')
          .description('Show one knowledge document')
          .action(async (id: string) => {
            assertUuid(id);
            console.log(formatDocDetail(await client.getKnowledge(id)));
          });

        const research = cmd.command('research').description('Research documents');
        research
          .command('list')
          .description('List research documents')
          .action(async () => {
            if (!config.projectId) throw new Error(NEEDS_PROJECT);
            const docs = await client.listResearch({ ...docScope, projectId: config.projectId });
            for (const d of docs) console.log(formatDocLine(d));
          });
        research
          .command('get <id>')
          .description('Show one research document')
          .action(async (id: string) => {
            assertUuid(id);
            if (!config.projectId) throw new Error(NEEDS_PROJECT);
            console.log(
              formatDocDetail(await client.getResearch(id, { projectId: config.projectId })),
            );
          });

        const procedures = cmd.command('procedures').description('Stored procedures');
        procedures
          .command('list')
          .description('List procedures')
          .action(async () => {
            const procs = await client.listProcedures(docScope);
            for (const p of procs) console.log(formatProcedureLine(p));
          });

        const intentions = cmd.command('intentions').description('Prospective memory');
        intentions
          .command('list')
          .description('List intentions')
          .action(async () => {
            const items = await client.listIntentions(scope);
            for (const i of items) console.log(formatIntentionLine(i));
          });
        intentions
          .command('due')
          .description('List intentions that are due now')
          .action(async () => {
            const items = await client.listDueIntentions(scope);
            for (const i of items) console.log(formatIntentionLine(i));
          });

        const state = cmd.command('state').description('Agent working state');
        state
          .command('list')
          .description('List working-state entries')
          .action(async () => {
            const entries = await client.listState(scope);
            for (const e of entries) console.log(formatStateLine(e));
          });
        state
          .command('get <key>')
          .description('Read one working-state key')
          .action(async (key: string) => {
            console.log(formatStateLine(await client.getState(key, scope)));
          });

        cmd
          .command('audit <targetId>')
          .description('Revision history and audit events for a memory item')
          .action(async (targetId: string) => {
            assertUuid(targetId, 'targetId');
            const { revisions, events } = await client.audit(targetId);
            for (const e of events) {
              console.log(`${e.at} ${e.kind}${e.actor ? ` by ${e.actor}` : ''}`);
            }
            for (const r of revisions) {
              console.log(`${r.archivedAt} revision ${r.originalKind}: ${r.reason}`);
            }
          });
      },
      { commands: ['elephant'] },
    );
  },
};
