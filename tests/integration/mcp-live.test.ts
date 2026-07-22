// End-to-end verification of the MCP adapter's 34 tool handlers against a REAL
// listening elephant server.
//
// `adapters/mcp/tests/tools.test.ts` drives the same tools through an in-memory
// MCP transport with `fetch` stubbed: it proves each handler builds the request
// it means to build and renders the payload it is handed, but every response is
// a hand-written fixture. Nothing there can catch a route that 404s, a scope
// axis the server rejects, a wire field the server never actually emits, or a
// recall opt-in that silently returns nothing.
//
// So this binds an ephemeral port, points a real `ElephantClient` at it, and
// registers the adapter's tools against that client. Handlers are captured with
// a stub `McpServer`-shaped recorder rather than a transport — the MCP protocol
// layer is already covered by the adapter's own suite; what is uncovered is the
// half of each handler that talks to elephant.

import { randomUUID } from 'node:crypto';
import { ElephantClient } from '@elephant/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { McpScopeConfig } from '../../adapters/mcp/src/config.ts';
import { registerTools } from '../../adapters/mcp/src/tools.ts';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { buildHttpServer } from '../../src/http/server.ts';
import { type Container, bootstrap, shutdown } from '../../src/index.ts';
import { assertDestructiveAllowed } from './guard.ts';

const TOKEN = process.env.__TEST_TOKEN ?? 'test-token';
const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);

const PROJECT = `proj-${randomUUID()}`;
const SESSION = `sess-${randomUUID()}`;
const AGENT = 'mcp-live-test';
const USER = `user-${randomUUID()}`;

/** A distinctive token shared by the recall seeds, so one query pulls all three. */
const ZORB = 'zorblatt';

type ToolText = { content: Array<{ type: string; text: string }> };
type Handler = (args: Record<string, unknown>) => Promise<ToolText>;

/**
 * Minimal `McpServer` stand-in: records what `registerTools` registers so a
 * handler can be invoked directly. Args are passed through as-is — zod
 * validation of the input schema is the adapter suite's job, ours is behaviour.
 */
function createToolRecorder() {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool(name: string, _config: unknown, handler: Handler) {
      handlers.set(name, handler);
    },
  };
  return {
    server,
    names: () => [...handlers.keys()].sort(),
    async call(name: string, args: Record<string, unknown> = {}): Promise<string> {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`tool not registered: ${name}`);
      const result = await handler(args);
      return result.content.map((c) => c.text).join('\n');
    },
  };
}

type Recorder = ReturnType<typeof createToolRecorder>;

let container: Container;
let app: Awaited<ReturnType<typeof buildHttpServer>>;
let client: ElephantClient;
let tools: Recorder;
/** Same tools, but with no projectId configured and a client that cannot
 *  connect — so "made no request" is provable: a request would throw. */
let unscoped: Recorder;

beforeAll(async () => {
  assertDestructiveAllowed();
  container = await bootstrap({
    llm: createFakeLLMAdapter({}),
    embedder: createFakeEmbeddingAdapter({ dim: EMBED_DIM }),
  });
  app = await buildHttpServer(container);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('expected a TCP address');
  const url = `http://127.0.0.1:${addr.port}`;
  client = new ElephantClient({ url, token: TOKEN, retries: 0 });

  const scope: McpScopeConfig = {
    agentId: AGENT,
    sessionId: SESSION,
    projectId: PROJECT,
    userId: USER,
    agentScope: 'boost',
    sessionScope: 'boost',
    projectScope: 'boost',
    userScope: 'boost',
  };
  tools = createToolRecorder();
  registerTools(tools.server as Parameters<typeof registerTools>[0], client, scope);

  // Port 1 is never listening — any outbound call fails loudly.
  const deadClient = new ElephantClient({ url: 'http://127.0.0.1:1', token: TOKEN, retries: 0 });
  unscoped = createToolRecorder();
  registerTools(unscoped.server as Parameters<typeof registerTools>[0], deadClient, {
    ...scope,
    projectId: undefined,
    userId: undefined,
    projectScope: 'none',
    userScope: 'none',
  });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await shutdown();
});

describe('surface', () => {
  test('registers all 34 tools', () => {
    expect(tools.names()).toHaveLength(34);
    expect(tools.names()).toContain('memory_research_save');
  });
});

// ── Knowledge ────────────────────────────────────────────────────────────────

describe('knowledge tools against a live server', () => {
  let docId: string;

  test('memory_knowledge_save ingests and returns the id', async () => {
    const text = await tools.call('memory_knowledge_save', {
      title: 'MCP live knowledge',
      source: 'mcp-live-spec',
      content: 'The knowledge body mentions kudufox as an unusual load balancer.',
      summary: 'a summary',
      tags: ['mcp', 'live'],
      sourceUri: 'https://example.test/kb',
    });
    expect(text).toMatch(/^Saved knowledge document [0-9a-f-]{36} — MCP live knowledge$/);
    docId = text.match(/[0-9a-f-]{36}/)![0];
  });

  test('memory_knowledge_get returns the full body', async () => {
    const text = await tools.call('memory_knowledge_get', { id: docId });
    expect(text).toContain(`MCP live knowledge [${docId}]`);
    expect(text).toContain('source: mcp-live-spec (https://example.test/kb)');
    expect(text).toContain('tags: mcp, live');
    expect(text).toContain('kudufox');
  });

  test('memory_knowledge_list finds it in project scope', async () => {
    const text = await tools.call('memory_knowledge_list', { limit: 50 });
    expect(text).toContain(`[${docId}] MCP live knowledge`);
    expect(text).toContain('#mcp #live');
  });

  test('memory_knowledge_update persists and archives a revision', async () => {
    const text = await tools.call('memory_knowledge_update', {
      id: docId,
      summary: 'revised summary',
      reason: 'mcp-live revision',
    });
    expect(text).toBe(`Updated knowledge document ${docId} — MCP live knowledge`);
    expect(await tools.call('memory_knowledge_get', { id: docId })).toContain(
      'summary: revised summary',
    );
  });

  test('memory_audit shows the revision the update archived', async () => {
    const text = await tools.call('memory_audit', { targetId: docId });
    expect(text).toContain('Revisions:');
    expect(text).toContain('mcp-live revision');
  });

  test('memory_knowledge_delete soft-deletes without touching chunks', async () => {
    const text = await tools.call('memory_knowledge_delete', { id: docId });
    // DELETE without purge never deletes chunks (routes/knowledge.ts only calls
    // KnowledgeChunkRepository.deleteForDocument under `purge`), so a chunk
    // count here would always be a misleading zero.
    expect(text).toBe(
      `Soft-deleted knowledge document ${docId}. Chunks and audit history preserved.`,
    );
    // Soft-delete is observable on the wire: expiresAt is stamped, and the
    // document stays readable.
    const doc = await client.getKnowledge(docId);
    expect(doc.expiresAt).not.toBeNull();
    expect(Date.parse(doc.expiresAt!)).toBeLessThanOrEqual(Date.now() + 1000);
  });

  test('memory_knowledge_delete with purge destroys chunks but only soft-deletes the doc', async () => {
    const saved = await tools.call('memory_knowledge_save', {
      title: 'Purge me',
      source: 'mcp-live-spec',
      content: 'Transient content that should not survive a purge.',
    });
    const id = saved.match(/[0-9a-f-]{36}/)![0]!;
    const text = await tools.call('memory_knowledge_delete', { id, purge: true });
    // The count is the server's, not a constant: the doc really was chunked.
    const chunks = Number(text.match(/Purged (\d+) chunks/)![1]);
    expect(chunks).toBeGreaterThan(0);
    expect(text).toBe(
      `Purged ${chunks} chunks and all attachments of knowledge document ${id}; the document itself is soft-deleted and still readable by id. Audit history preserved.`,
    );
    // Purge is NOT a hard delete: the node survives, soft-deleted, and readable.
    const doc = await client.getKnowledge(id);
    expect(doc.expiresAt).not.toBeNull();
    expect(await tools.call('memory_knowledge_get', { id })).toContain(`Purge me [${id}]`);
  });
});

// ── Research ─────────────────────────────────────────────────────────────────

describe('research tools against a live server', () => {
  let docId: string;

  test('memory_research_save without a project id makes no request', async () => {
    const text = await unscoped.call('memory_research_save', {
      title: 't',
      source: 'web',
      content: 'c',
    });
    // If a request had been attempted, the dead client would have thrown ECONNREFUSED.
    expect(text).toContain('no project id is configured');
    expect(text).toContain('ELEPHANT_PROJECT_ID');
  });

  test('memory_research_list without a project id makes no request', async () => {
    expect(await unscoped.call('memory_research_list', {})).toContain(
      'no project id is configured',
    );
  });

  test('memory_research_save stores against the configured project', async () => {
    const text = await tools.call('memory_research_save', {
      title: 'MCP live research',
      source: 'mcp-live-spec',
      content: 'Research body naming pangolinware as the subject under study.',
      summary: 'research summary',
      tags: ['research'],
    });
    expect(text).toMatch(/^Saved research [0-9a-f-]{36} — MCP live research$/);
    docId = text.match(/[0-9a-f-]{36}/)![0];
  });

  test('memory_research_get returns the body for the configured project', async () => {
    const text = await tools.call('memory_research_get', { id: docId });
    expect(text).toContain(`MCP live research [${docId}]`);
    expect(text).toContain('pangolinware');
  });

  test('memory_research_list returns it', async () => {
    const text = await tools.call('memory_research_list', { limit: 50 });
    expect(text).toContain(`[${docId}] MCP live research`);
  });

  test('memory_research_update round-trips and archives a revision', async () => {
    const text = await tools.call('memory_research_update', {
      id: docId,
      content: 'Revised research body about pangolinware.',
      reason: 'mcp-live research revision',
    });
    expect(text).toBe(`Updated research ${docId} — MCP live research`);
    expect(await tools.call('memory_research_get', { id: docId })).toContain(
      'Revised research body',
    );
    expect(await tools.call('memory_audit', { targetId: docId })).toContain(
      'mcp-live research revision',
    );
  });

  test('memory_research_delete soft-deletes it — readable by id, gone from the list', async () => {
    expect(await tools.call('memory_research_delete', { id: docId })).toBe(
      `Soft-deleted research ${docId}. Audit history preserved.`,
    );
    // Nothing is hard-deleted, so a direct read still succeeds; the deletion is
    // observable as a stamped expiresAt, not as a 404.
    const doc = await client.getResearch(docId, { projectId: PROJECT });
    expect(doc.expiresAt).not.toBeNull();
    expect(Date.parse(doc.expiresAt!)).toBeLessThanOrEqual(Date.now() + 1000);
    expect(await tools.call('memory_research_get', { id: docId })).toContain(
      `MCP live research [${docId}]`,
    );
    // The list route does filter expired rows (ResearchRepository.list).
    expect(await tools.call('memory_research_list', { limit: 50 })).not.toContain(docId);
    // And the audit trail survives the delete.
    expect(await tools.call('memory_audit', { targetId: docId })).toContain(
      'mcp-live research revision',
    );
  });
});

// ── Procedures ───────────────────────────────────────────────────────────────

describe('procedure tools against a live server', () => {
  const name = `mcp-live-proc-${randomUUID()}`;
  let procId: string;
  let supersedingId: string;

  test('memory_procedure_save creates v1', async () => {
    const text = await tools.call('memory_procedure_save', {
      name,
      content: 'Step one: check the ocelotd daemon.',
      whenToUse: 'when the ocelotd daemon misbehaves',
    });
    expect(text).toMatch(new RegExp(`^Saved procedure [0-9a-f-]{36} — ${name} \\(v1\\)$`));
    procId = text.match(/[0-9a-f-]{36}/)![0];
  });

  test('memory_procedure_get by id renders the body', async () => {
    const text = await tools.call('memory_procedure_get', { id: procId });
    expect(text).toContain(`${name} (v1) [${procId}]`);
    expect(text).toContain('when: when the ocelotd daemon misbehaves');
    // ProcedureService.create seeds successRate at 0.5 — a new procedure is
    // "unknown", not "known bad".
    expect(text).toContain('success: 0.50 over 0 runs');
    expect(text).toContain('Step one: check the ocelotd daemon.');
  });

  test('memory_procedure_get by name resolves through the list route', async () => {
    expect(await tools.call('memory_procedure_get', { name })).toContain(`[${procId}]`);
    expect(await tools.call('memory_procedure_get', { name: 'no-such-procedure' })).toBe(
      'No procedure named "no-such-procedure".',
    );
  });

  test('memory_procedure_list includes it with its trigger', async () => {
    const text = await tools.call('memory_procedure_list', { limit: 50 });
    expect(text).toContain(`[${procId}] ${name} (v1): when the ocelotd daemon misbehaves`);
  });

  // Server behaviour worth pinning: a body-changing update writes the new body
  // onto the original node AND creates a superseding clone, returning the
  // clone's id. So the id in the response is not the id that was sent.
  // (`ProcedureService.update` → `willChangeBody` branch.)
  test('memory_procedure_update bumps the version and returns the superseding id', async () => {
    const text = await tools.call('memory_procedure_update', {
      id: procId,
      content: 'Step one: restart the ocelotd daemon.',
      successRate: 0.5,
      reason: 'mcp-live procedure revision',
    });
    expect(text).toMatch(new RegExp(`^Updated procedure [0-9a-f-]{36} — ${name} \\(v2\\)$`));
    supersedingId = text.match(/[0-9a-f-]{36}/)![0]!;
    expect(supersedingId).not.toBe(procId);

    // Both ids resolve, both at v2, both carrying the new body.
    for (const id of [procId, supersedingId]) {
      const fetched = await tools.call('memory_procedure_get', { id });
      expect(fetched, id).toContain(`${name} (v2) [${id}]`);
      expect(fetched, id).toContain('restart the ocelotd daemon');
      expect(fetched, id).toContain('success: 0.50');
    }
  });

  test('memory_procedure_delete soft-deletes it', async () => {
    for (const id of [procId, supersedingId]) {
      expect(await tools.call('memory_procedure_delete', { id })).toBe(
        `Soft-deleted procedure ${id}. Audit history preserved.`,
      );
      // Soft-delete stamps expiresAt; the procedure stays readable by id.
      const proc = await client.getProcedure(id);
      expect(proc.expiresAt, id).not.toBeNull();
      expect(Date.parse(proc.expiresAt!)).toBeLessThanOrEqual(Date.now() + 1000);
    }
    // KNOWN SERVER DEFECT, pinned rather than hidden: `ProcedureRepository.list`
    // has no expiry predicate, so soft-deleted procedures keep coming back in
    // the list — exactly the bug `ResearchRepository.list` carries a dated
    // comment about having fixed (2026-07-20) for Research. When that predicate
    // is added to procedures, flip these two assertions.
    const listed = await tools.call('memory_procedure_list', { limit: 50 });
    expect(listed).toContain(procId);
    expect(listed).toContain(supersedingId);
  });
});

// ── Intentions ───────────────────────────────────────────────────────────────

describe('intention tools against a live server', () => {
  let pendingId: string;
  let cancelId: string;
  let dueId: string;

  const idOf = (text: string) => text.match(/[0-9a-f-]{36}/)![0];

  test('memory_intention_create records one-offs', async () => {
    const soon = new Date(Date.now() + 86_400_000).toISOString();
    const created = await tools.call('memory_intention_create', {
      content: `Publish the ${ZORB} findings to the team.`,
      dueAt: soon,
      importance: 0.7,
    });
    expect(created).toContain(`due ${soon}`);
    pendingId = idOf(created);

    cancelId = idOf(
      await tools.call('memory_intention_create', {
        content: 'Abandon this one.',
        triggerHint: 'if the rollout is ever revisited',
      }),
    );
    dueId = idOf(
      await tools.call('memory_intention_create', {
        content: 'Already overdue item.',
        dueAt: new Date(Date.now() - 3_600_000).toISOString(),
        triggerHint: 'on the next standup',
      }),
    );
  });

  // IntentionService rejects an intention with no dueAt/triggerHint/schedule
  // (it could never surface). The adapter guards ahead of the request so the
  // model gets an actionable sentence instead of an opaque 400 — the dead
  // client proves no call is attempted, since one would throw ECONNREFUSED.
  test('memory_intention_create refuses a trigger-less intention without calling the server', async () => {
    const text = await unscoped.call('memory_intention_create', { content: 'Never surfaces.' });
    expect(text).toContain('An intention needs something to surface it.');
    expect(text).toContain('dueAt');
    expect(text).toContain('triggerHint');
    expect(text).toContain('schedule');
    expect(text).not.toMatch(/[0-9a-f-]{36}/);
  });

  test('memory_intention_list shows pending items', async () => {
    const text = await tools.call('memory_intention_list', { status: 'pending', limit: 50 });
    expect(text).toContain(`[${pendingId}] (pending, due `);
    expect(text).toContain(`Publish the ${ZORB} findings`);
    expect(text).toContain(cancelId);
  });

  test('memory_intention_due surfaces only what is already due', async () => {
    const text = await tools.call('memory_intention_due', { limit: 50 });
    expect(text).toContain(`[${dueId}]`);
    expect(text).toContain('when on the next standup');
    // Due tomorrow — must not appear in a "due now" query.
    expect(text).not.toContain(pendingId);
  });

  test('memory_intention_fired bumps the fire count', async () => {
    expect(await tools.call('memory_intention_fired', { id: dueId })).toBe(
      `Marked intention ${dueId} as fired (1 times).`,
    );
    expect(await tools.call('memory_intention_fired', { id: dueId })).toContain('(2 times)');
  });

  test('memory_intention_cancel moves it out of pending', async () => {
    expect(
      await tools.call('memory_intention_cancel', { id: cancelId, reason: 'no longer wanted' }),
    ).toBe(`Cancelled intention ${cancelId} (status cancelled).`);
    expect(
      await tools.call('memory_intention_list', { status: 'pending', limit: 50 }),
    ).not.toContain(cancelId);
    expect(await tools.call('memory_intention_list', { status: 'cancelled', limit: 50 })).toContain(
      cancelId,
    );
  });

  test('memory_intention_complete resolves the due item', async () => {
    expect(await tools.call('memory_intention_complete', { id: dueId, reason: 'handled' })).toBe(
      `Completed intention ${dueId} (status completed).`,
    );
    expect(await tools.call('memory_intention_list', { status: 'completed', limit: 50 })).toContain(
      dueId,
    );
  });
});

// ── Working state ────────────────────────────────────────────────────────────

describe('working-state tools against a live server', () => {
  const key = `mcp-live-${randomUUID()}`;

  test('memory_state_get on an unset key is an answer, not an error', async () => {
    expect(await tools.call('memory_state_get', { key: 'definitely-unset-key' })).toBe(
      'State "definitely-unset-key" is not set.',
    );
  });

  test('memory_state_set then get round-trips the value', async () => {
    expect(await tools.call('memory_state_set', { key, value: 'feat/mcp-live', ttlSec: 600 })).toBe(
      `Set state ${key} (expires in 600s).`,
    );
    const text = await tools.call('memory_state_get', { key });
    expect(text).toContain(`- ${key}: feat/mcp-live`);
    expect(text).toContain('(expires ');
  });

  test('memory_state_list filters by prefix', async () => {
    expect(await tools.call('memory_state_list', {})).toContain(key);
    expect(await tools.call('memory_state_list', { prefix: 'mcp-live-' })).toContain(key);
    expect(await tools.call('memory_state_list', { prefix: 'no-such-prefix-' })).toBe(
      'No state entries.',
    );
  });

  test('memory_state_delete removes it', async () => {
    expect(await tools.call('memory_state_delete', { key })).toBe(`Deleted state ${key}.`);
    expect(await tools.call('memory_state_get', { key })).toBe(`State "${key}" is not set.`);
  });
});

// ── Facts, entities, preferences, observations ───────────────────────────────

describe('fact, entity, preference and observation tools', () => {
  let factId: string;

  test('memory_save persists a fact with an entity', async () => {
    const text = await tools.call('memory_save', {
      fact: 'The Quokkacorn service owns the billing ledger.',
      category: 'architecture',
      importance: 0.8,
      entities: ['Quokkacorn'],
    });
    expect(text).toMatch(/^Saved fact [0-9a-f-]{36} \[architecture\]$/);
    factId = text.match(/[0-9a-f-]{36}/)![0];
  });

  test('memory_entity finds the entity by name and then by id', async () => {
    const byName = await tools.call('memory_entity', { name: 'Quokkacorn' });
    expect(byName).toMatch(/^- Quokkacorn \(/);
    const entityId = byName.match(/\[([0-9a-f-]{36})\]/)![1]!;
    const byId = await tools.call('memory_entity', { id: entityId });
    expect(byId).toContain(`[${entityId}]`);
    expect(byId).toContain('billing ledger');
    expect(await tools.call('memory_entity', { name: 'NoSuchEntityAnywhere' })).toBe(
      'No entities matching "NoSuchEntityAnywhere".',
    );
  });

  test('memory_timeline reports beliefs at an instant', async () => {
    const at = new Date().toISOString();
    const text = await tools.call('memory_timeline', { at, entity: 'Quokkacorn' });
    expect(text).toContain('Beliefs valid at');
    expect(text).toContain(factId);
    expect(await tools.call('memory_timeline', { at, entity: 'NoSuchEntityAnywhere' })).toBe(
      'No entity found matching "NoSuchEntityAnywhere".',
    );
  });

  test('memory_preference_set then get round-trips', async () => {
    const key = `pref-${randomUUID()}`;
    expect(await tools.call('memory_preference_get', { key })).toBe(
      `Preference "${key}" is not set.`,
    );
    const set = await tools.call('memory_preference_set', {
      key,
      value: 'espresso',
      confidence: 0.9,
    });
    expect(set).toContain(`Set ${key} = "espresso" (validFrom `);
    expect(await tools.call('memory_preference_get', { key })).toBe(
      `${key}: espresso (confidence 0.9)`,
    );
    // And the preference is readable as-of now through the timeline tool.
    expect(
      await tools.call('memory_timeline', { at: new Date().toISOString(), preferenceKey: key }),
    ).toContain(`Preference ${key}: espresso`);
  });

  test('memory_observe writes a session-scoped note with an expiry', async () => {
    const text = await tools.call('memory_observe', { note: 'mid-refactor of the auth module' });
    expect(text).toMatch(/^Observed \(expires .+\)\.$/);
    const { observations } = await client.listObservations(SESSION);
    expect(observations.some((o) => o.content === 'mid-refactor of the auth module')).toBe(true);
  });

  test('memory_forget by factId soft-deletes', async () => {
    expect(await tools.call('memory_forget', { factId })).toBe(
      `Soft-deleted fact ${factId}. Audit history preserved.`,
    );
    expect(await tools.call('memory_forget', {})).toBe('Provide factId or query.');
  });

  test('memory_forget by fuzzy query surfaces the matching fact', async () => {
    const saved = await tools.call('memory_save', {
      fact: 'Grumbleflix deploys every Thursday at noon.',
      category: 'ops',
    });
    const targetId = saved.match(/[0-9a-f-]{36}/)![0]!;
    const text = await tools.call('memory_forget', { query: 'Grumbleflix deploys' });
    // Either branch is legitimate (the corpus may hold other candidates), but
    // the target must be found and named — a fuzzy forget that misses is a bug.
    expect(text).toContain(targetId);
    expect(text).toMatch(/Soft-deleted the single match|Multiple matches/);
    expect(await tools.call('memory_forget', { query: 'nothingmatchesthisstring' })).toBe(
      'No matching facts.',
    );
  });
});

// ── Recall: the whole point of the v1.2 include* opt-ins ─────────────────────

describe('memory_recall surfaces every v1.2 category from a live server', () => {
  let researchId: string;
  let intentionId: string;

  beforeAll(async () => {
    await tools.call('memory_knowledge_save', {
      title: `The ${ZORB} protocol`,
      source: 'mcp-live-spec',
      content: `The ${ZORB} protocol requires three handshakes before commit.`,
      summary: `how ${ZORB} commits`,
    });
    const research = await tools.call('memory_research_save', {
      title: `${ZORB} benchmarks`,
      source: 'mcp-live-spec',
      content: `${ZORB} benchmarks show a forty percent improvement in recall latency.`,
      summary: `${ZORB} performance numbers`,
    });
    researchId = research.match(/[0-9a-f-]{36}/)![0]!;
    const intention = await tools.call('memory_intention_create', {
      content: `Escalate the ${ZORB} rollout to the platform team.`,
      dueAt: new Date(Date.now() + 172_800_000).toISOString(),
    });
    intentionId = intention.match(/[0-9a-f-]{36}/)![0]!;
    await tools.call('memory_save', { fact: `The ${ZORB} protocol is owned by platform.` });
    await tools.call('memory_procedure_save', {
      name: `${ZORB}-runbook-${randomUUID()}`,
      content: `Run the ${ZORB} checklist.`,
      whenToUse: `when the ${ZORB} protocol stalls`,
    });
  }, 60_000);

  test('renders facts, knowledge, research and intentions in one response', async () => {
    const text = await tools.call('memory_recall', { query: ZORB, limit: 50 });

    expect(text).not.toBe('No matches.');
    expect(text).toContain('Facts:');
    expect(text).toContain('is owned by platform');

    // includeKnowledge — chunk text quoted under its document id.
    expect(text).toContain('Knowledge:');
    expect(text).toContain('three handshakes before commit');

    // includeResearch — both the document and its excerpt sections.
    expect(text).toContain('Research:');
    expect(text).toContain(`[${researchId}] ${ZORB} benchmarks`);

    // includeIntentions.
    expect(text).toContain('Intentions:');
    expect(text).toContain(`[${intentionId}]`);
    expect(text).toContain('Escalate the');

    // includeProcedures.
    expect(text).toContain('Procedures:');
    expect(text).toContain(`when the ${ZORB} protocol stalls`);
  });

  // `memory_recall` opts into every v1.2 category, and several of those sources
  // are not query-gated: preferences in scope are returned whatever the query
  // is. So the 'No matches.' stand-in is unreachable from this tool once a
  // single preference exists — a nonsense query still yields a full response.
  test('a nonsense query still renders the always-on sections, not the empty stand-in', async () => {
    const text = await tools.call('memory_recall', { query: 'xyzzyplughnothingmatches' });
    expect(text).not.toBe('No matches.');
    expect(text).toContain('Preferences:');
    expect(text).toContain('espresso');
  });

  // (The 'No matches.' stand-in is exercised where it is actually reachable —
  // the fact-only, agent-filtered recall behind memory_forget, asserted in the
  // "memory_forget by fuzzy query" test above.)

  test('temporal and importance filters are accepted by the live route', async () => {
    const text = await tools.call('memory_recall', {
      query: ZORB,
      from: new Date(Date.now() - 86_400_000).toISOString(),
      to: new Date(Date.now() + 86_400_000).toISOString(),
      minImportance: 0.1,
      limit: 10,
    });
    expect(typeof text).toBe('string');
    expect(text).not.toBe('');
  });
});

// ── Audit ────────────────────────────────────────────────────────────────────

describe('memory_audit against a live server', () => {
  test('reports no history for an unknown target', async () => {
    const id = randomUUID();
    expect(await tools.call('memory_audit', { targetId: id })).toBe(`No audit history for ${id}.`);
  });
});
