// End-to-end verification of the OpenClaw plugin's 34 tool handlers against a
// REAL listening server.
//
// `adapters/openclaw/tests/plugin.test.ts` drives the same handlers against a
// stubbed `fetch`: it proves the plugin *builds* the right request, never that
// the server accepts it or that the response renders. That gap matters most for
// the 26 tools added in v1.2 (knowledge/research/procedure/intention/state/audit)
// — none of them had ever made a real call — and for recall's include* opt-ins,
// where a missing flag silently yields an empty section rather than an error.
//
// Same shape as client-live.test.ts: bootstrap a container with fake llm/embedder,
// bind an ephemeral port, and point the plugin's vendored client at it over a
// real socket.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import plugin from '../../adapters/openclaw/index.ts';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { read } from '../../src/config/neo4j.ts';
import { buildHttpServer } from '../../src/http/server.ts';
import { type Container, bootstrap, shutdown } from '../../src/index.ts';
import { EpisodeRepository } from '../../src/repositories/EpisodeRepository.ts';
import { assertDestructiveAllowed } from './guard.ts';

const TOKEN = process.env.__TEST_TOKEN ?? 'test-token';
const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);

// Distinctive tokens: the fake embedder is a hashed bag-of-tokens, so a query
// sharing rare words with the stored body scores near 1.0 and cannot be crowded
// out by whatever other specs left in the shared container.
const MARKER = 'zorblatt';
const KNOWLEDGE_BODY = `${MARKER} deployment ritual runs every thursday at dawn`;
const RESEARCH_BODY = `${MARKER} field study of quokka migration under moonlight`;
const INTENTION_BODY = `${MARKER} follow up on the quokka migration report`;
const RECALL_QUERY = `${MARKER} deployment ritual quokka migration`;

interface RegisteredTool {
  name: string;
  // biome-ignore lint/suspicious/noExplicitAny: mirrors the host's untyped surface
  execute: (toolCallId: string, params: any) => Promise<{ content: Array<{ text: string }> }>;
}

/** The same harness shape the host gives `register()`; see plugin.test.ts. */
function makeFakeApi(config: Record<string, unknown>) {
  const tools = new Map<string, RegisteredTool>();
  // biome-ignore lint/suspicious/noExplicitAny: mirrors the host's untyped surface
  const hooks = new Map<string, (event: any) => Promise<any>>();
  return {
    api: {
      pluginConfig: config,
      // biome-ignore lint/suspicious/noExplicitAny: host-supplied shape
      registerTool(tool: any) {
        tools.set(tool.name, tool);
      },
      // biome-ignore lint/suspicious/noExplicitAny: host-supplied shape
      on(event: string, handler: (event: any) => Promise<any>) {
        hooks.set(event, handler);
      },
      registerCli() {
        /* CLI surface is covered by the unit spec */
      },
    },
    tools,
    hooks,
  };
}

let container: Container;
let app: Awaited<ReturnType<typeof buildHttpServer>>;
let harness: ReturnType<typeof makeFakeApi>;
let url: string;

const PROJECT = `proj-${randomUUID()}`;
const AGENT = `openclaw-live-${randomUUID()}`;
const USER = `user-${randomUUID()}`;

/** Invoke a registered tool and return its single rendered text block. */
async function call(name: string, params: Record<string, unknown> = {}): Promise<string> {
  const tool = harness.tools.get(name);
  if (!tool) throw new Error(`tool ${name} is not registered`);
  const result = await tool.execute(`call-${randomUUID()}`, params);
  return result.content[0]!.text;
}

/** Pull a UUID out of a tool's confirmation line ("Saved knowledge document <id> — …"). */
function idFrom(rendered: string): string {
  const match = rendered.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (!match) throw new Error(`no id in tool output: ${rendered}`);
  return match[0];
}

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
  url = `http://127.0.0.1:${addr.port}`;

  harness = makeFakeApi({
    url,
    token: TOKEN,
    agentId: AGENT,
    projectId: PROJECT,
    userId: USER,
    autoRecall: { limit: 8 },
  });
  plugin.register(harness.api);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await shutdown();
});

describe('registration against a live config', () => {
  test('all 34 tools and both hooks are registered', () => {
    expect(harness.tools.size).toBe(34);
    expect(Array.from(harness.hooks.keys()).sort()).toEqual(['agent_end', 'before_agent_start']);
  });
});

// ── the original 8 ──────────────────────────────────────────────────────────

describe('facts, entities, preferences, observations', () => {
  let factId: string;

  test('memory_save writes a fact the server accepts', async () => {
    const out = await call('memory_save', {
      fact: `${MARKER} the release train departs on thursday`,
      category: 'process',
      importance: 0.8,
      entities: ['Zorblatt Corp'],
    });
    expect(out).toMatch(/^Saved fact /);
    expect(out).toContain('[process]');
    factId = idFrom(out);
  });

  test('memory_recall surfaces the saved fact', async () => {
    const out = await call('memory_recall', { query: `${MARKER} release train thursday` });
    expect(out).toContain('Facts:');
    expect(out).toContain('the release train departs on thursday');
  });

  test('memory_entity finds the entity created alongside the fact', async () => {
    const byName = await call('memory_entity', { name: 'Zorblatt' });
    expect(byName).toContain('Zorblatt');
    const entityId = idFrom(byName);
    const byId = await call('memory_entity', { id: entityId });
    expect(byId).toContain(entityId);
  });

  test('memory_timeline reports beliefs valid now', async () => {
    const out = await call('memory_timeline', { at: new Date().toISOString() });
    expect(out).toContain('Beliefs valid at');
  });

  test('memory_preference_set then _get round-trips; unset keys are reported', async () => {
    const key = `pref-${randomUUID()}`;
    const set = await call('memory_preference_set', { key, value: 'espresso', confidence: 0.9 });
    expect(set).toContain(`Set ${key} = "espresso"`);
    expect(set).toContain('validFrom');
    const got = await call('memory_preference_get', { key });
    expect(got).toContain('espresso');
    const missing = await call('memory_preference_get', { key: `absent-${randomUUID()}` });
    expect(missing).toMatch(/is not set\.$/);
  });

  test('memory_observe writes a session observation', async () => {
    const out = await call('memory_observe', {
      note: 'the live spec observed something',
      sessionId: `sess-${randomUUID()}`,
    });
    expect(out).toMatch(/^Observed \(expires /);
  });

  test('memory_forget soft-deletes by id', async () => {
    const out = await call('memory_forget', { factId });
    expect(out).toBe(`Soft-deleted fact ${factId}. Audit history preserved.`);
  });

  test('memory_forget by query resolves against the real index', async () => {
    const unique = `quibbleflux-${randomUUID().slice(0, 8)}`;
    await call('memory_save', { fact: `${unique} is a one-off marker fact` });
    const out = await call('memory_forget', { query: unique });
    expect(out).toMatch(/Soft-deleted the single match|Multiple matches/);
  });
});

// ── knowledge ───────────────────────────────────────────────────────────────

describe('memory_knowledge_* round-trip', () => {
  let docId: string;

  test('save', async () => {
    const out = await call('memory_knowledge_save', {
      title: 'Zorblatt deployment handbook',
      source: 'handbook',
      content: KNOWLEDGE_BODY,
      summary: 'when deploys happen',
      tags: ['live', 'deploy'],
    });
    expect(out).toMatch(/^Saved knowledge document /);
    docId = idFrom(out);
  });

  test('get returns the full body', async () => {
    const out = await call('memory_knowledge_get', { id: docId });
    expect(out).toContain('Zorblatt deployment handbook');
    expect(out).toContain('{live, deploy}');
    expect(out).toContain(KNOWLEDGE_BODY);
  });

  test('list includes it within the configured scope', async () => {
    const out = await call('memory_knowledge_list', { limit: 50 });
    expect(out).toContain(docId);
  });

  test('update archives a revision', async () => {
    const out = await call('memory_knowledge_update', {
      id: docId,
      summary: 'revised summary',
      reason: 'live-spec revision',
    });
    expect(out).toContain(`Updated knowledge document ${docId}`);
    expect(await call('memory_knowledge_get', { id: docId })).toContain('revised summary');
  });

  test('memory_audit reports the revision and events', async () => {
    const out = await call('memory_audit', { targetId: docId });
    expect(out).toContain('Events:');
    expect(out).toContain('live-spec revision');
  });

  test('delete with purge reports the chunk count', async () => {
    const out = await call('memory_knowledge_delete', { id: docId, purge: true });
    expect(out).toMatch(
      new RegExp(`Soft-deleted knowledge document ${docId} \\(\\d+ chunks\\)\\.`),
    );
  });
});

// ── research ────────────────────────────────────────────────────────────────

describe('memory_research_* round-trip', () => {
  let researchId: string;

  test('save', async () => {
    const out = await call('memory_research_save', {
      title: 'Quokka migration study',
      source: 'https://example.test/quokka',
      content: RESEARCH_BODY,
    });
    expect(out).toMatch(/^Saved research /);
    researchId = idFrom(out);
  });

  test('get returns the full body', async () => {
    const out = await call('memory_research_get', { id: researchId });
    expect(out).toContain('Quokka migration study');
    expect(out).toContain(RESEARCH_BODY);
  });

  test('list is scoped to the configured project', async () => {
    const out = await call('memory_research_list', { limit: 50 });
    expect(out).toContain(researchId);
  });

  test('update round-trips through the project-scoped PUT', async () => {
    const out = await call('memory_research_update', {
      id: researchId,
      summary: 'quokkas move at night',
      reason: 'live-spec revision',
    });
    expect(out).toContain(`Updated research ${researchId}`);
    expect(await call('memory_research_get', { id: researchId })).toContain(
      'quokkas move at night',
    );
  });

  test('delete', async () => {
    const out = await call('memory_research_delete', { id: researchId });
    expect(out).toBe(`Soft-deleted research ${researchId}. Audit history preserved.`);
  });
});

describe('research without a configured projectId', () => {
  test('every research tool refuses locally and issues no request', async () => {
    const unscoped = makeFakeApi({ url, token: TOKEN, agentId: AGENT, userId: USER });
    plugin.register(unscoped.api);
    // Any real request now throws loudly instead of silently succeeding.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('research tool made a network request without a projectId');
    });
    try {
      for (const name of [
        'memory_research_save',
        'memory_research_get',
        'memory_research_list',
        'memory_research_update',
      ]) {
        const out = await unscoped.tools.get(name)!.execute('t1', {
          id: '00000000-0000-4000-8000-000000000000',
          title: 't',
          source: 's',
          content: 'c',
        });
        expect(out.content[0]!.text, name).toMatch(/project-scoped/);
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// ── procedures ──────────────────────────────────────────────────────────────

describe('memory_procedure_* round-trip', () => {
  const name = `proc-${randomUUID()}`;
  let procId: string;
  let supersedingId: string;

  test('save', async () => {
    const out = await call('memory_procedure_save', {
      name,
      content: '1. pull 2. build 3. ship',
      whenToUse: `when the ${MARKER} deployment ritual begins`,
    });
    expect(out).toContain('Saved procedure');
    expect(out).toContain('(v1)');
    procId = idFrom(out);
  });

  test('get by id and by name both resolve', async () => {
    const byId = await call('memory_procedure_get', { id: procId });
    expect(byId).toContain('1. pull 2. build 3. ship');
    const byName = await call('memory_procedure_get', { name });
    expect(byName).toContain(procId);
  });

  test('list includes it', async () => {
    expect(await call('memory_procedure_list', { limit: 50 })).toContain(procId);
  });

  // Documented server behaviour, surprising enough to pin: a body-changing
  // procedure update creates a *superseding clone*, so the update returns an id
  // the caller never sent. Callers must re-read the id from the response.
  test('a body-changing update bumps the version and returns a NEW id', async () => {
    const out = await call('memory_procedure_update', {
      id: procId,
      content: '1. pull 2. test 3. build 4. ship',
      successRate: 0.75,
      reason: 'live-spec revision',
    });
    expect(out).toMatch(/^Updated procedure /);
    expect(out).toContain(`${name} (v2)`);
    supersedingId = idFrom(out);
    expect(supersedingId).not.toBe(procId);
    // Both ids resolve; the clone carries the new body.
    expect(await call('memory_procedure_get', { id: supersedingId })).toContain('2. test');
  });

  test('a metadata-only update revises in place', async () => {
    const out = await call('memory_procedure_update', {
      id: supersedingId,
      successRate: 0.9,
      reason: 'live-spec metadata',
    });
    expect(out).toContain(`Updated procedure ${supersedingId}`);
    expect(out).toContain('(v2)');
  });

  test('delete both the original and the superseding clone', async () => {
    for (const id of [procId, supersedingId]) {
      expect(await call('memory_procedure_delete', { id })).toBe(
        `Soft-deleted procedure ${id}. Audit history preserved.`,
      );
    }
  });
});

// ── intentions ──────────────────────────────────────────────────────────────

describe('memory_intention_* lifecycle', () => {
  let intentionId: string;
  const dueAt = new Date(Date.now() + 3_600_000).toISOString();

  test('create', async () => {
    const out = await call('memory_intention_create', {
      content: INTENTION_BODY,
      dueAt,
      triggerHint: `${MARKER} quokka`,
      importance: 0.7,
    });
    expect(out).toContain(`due ${dueAt}`);
    intentionId = idFrom(out);
  });

  test('list filtered by status', async () => {
    const out = await call('memory_intention_list', { status: 'pending', limit: 50 });
    expect(out).toContain(intentionId);
    expect(out).toContain('(pending');
  });

  test('due lists it ahead of the horizon', async () => {
    const out = await call('memory_intention_due', {
      before: new Date(Date.now() + 172_800_000).toISOString(),
      limit: 50,
    });
    expect(out).toContain(intentionId);
  });

  test('fired increments the counter without leaving pending', async () => {
    const out = await call('memory_intention_fired', { id: intentionId, reason: 'surfaced' });
    expect(out).toBe(`Marked intention ${intentionId} fired (1 total).`);
  });

  test('complete', async () => {
    expect(await call('memory_intention_complete', { id: intentionId, reason: 'done' })).toBe(
      `Completed intention ${intentionId}.`,
    );
    expect(await call('memory_intention_list', { status: 'completed', limit: 50 })).toContain(
      intentionId,
    );
  });

  test('cancel a separate intention', async () => {
    const created = idFrom(
      await call('memory_intention_create', {
        content: 'abandon this one',
        triggerHint: 'never',
      }),
    );
    expect(await call('memory_intention_cancel', { id: created, reason: 'not needed' })).toBe(
      `Cancelled intention ${created}.`,
    );
  });

  // An intention with no dueAt, triggerHint, or schedule can never resurface,
  // and POST /intentions 400s on it. The tool must say so locally rather than
  // handing the model a raw server error.
  test('create without any trigger is refused locally, with no request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('memory_intention_create posted an untriggerable intention');
    });
    try {
      const out = await call('memory_intention_create', { content: 'no way to surface this' });
      expect(out).toMatch(/at least one of `dueAt`, `triggerHint`, or `schedule`/);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// ── working state ───────────────────────────────────────────────────────────

describe('memory_state_* round-trip', () => {
  const key = `k-${randomUUID()}`;

  test('set / get / list / delete', async () => {
    expect(await call('memory_state_set', { key, value: { n: 1 }, ttlSec: 300 })).toBe(
      `Set state ${key}.`,
    );
    const got = await call('memory_state_get', { key });
    expect(got).toContain(`${key} = {"n":1}`);
    expect(await call('memory_state_list', {})).toContain(key);
    expect(await call('memory_state_delete', { key })).toBe(`Deleted state ${key}.`);
    expect(await call('memory_state_get', { key })).toBe(`State "${key}" is not set.`);
  });

  test('prefix filter reaches the server', async () => {
    const prefix = `px${randomUUID().slice(0, 6)}`;
    await call('memory_state_set', { key: `${prefix}-a`, value: 1 });
    await call('memory_state_set', { key: `${prefix}-b`, value: 2 });
    const out = await call('memory_state_list', { prefix });
    expect(out).toContain(`${prefix}-a`);
    expect(out).toContain(`${prefix}-b`);
  });
});

// ── the point of the exercise: recall really returns the new categories ─────

describe('memory_recall surfaces knowledge, research, and intentions', () => {
  let seeded: { knowledgeId: string; researchId: string; intentionId: string };

  beforeAll(async () => {
    const knowledgeId = idFrom(
      await call('memory_knowledge_save', {
        title: 'Zorblatt deployment ritual',
        source: 'handbook',
        content: KNOWLEDGE_BODY,
        tags: ['recall'],
      }),
    );
    const researchId = idFrom(
      await call('memory_research_save', {
        title: 'Quokka migration under moonlight',
        source: 'https://example.test/quokka-2',
        content: RESEARCH_BODY,
      }),
    );
    const intentionId = idFrom(
      await call('memory_intention_create', {
        content: INTENTION_BODY,
        triggerHint: `${MARKER} quokka migration`,
        importance: 0.9,
      }),
    );
    await call('memory_procedure_save', {
      name: `recall-proc-${randomUUID()}`,
      content: 'run the ritual',
      whenToUse: `${MARKER} deployment ritual quokka migration`,
    });
    seeded = { knowledgeId, researchId, intentionId };
  }, 60_000);

  test('the rendered recall contains each seeded category', async () => {
    const out = await call('memory_recall', { query: RECALL_QUERY, limit: 50 });

    expect(out, 'knowledge section missing').toContain('Knowledge:');
    expect(out).toContain(seeded.knowledgeId);
    expect(out).toContain('deployment ritual runs every thursday');

    expect(out, 'research section missing').toContain('Research');
    expect(out).toContain(seeded.researchId);

    expect(out, 'intentions section missing').toContain('Intentions:');
    expect(out).toContain(seeded.intentionId);
    expect(out).toContain('follow up on the quokka migration report');

    expect(out, 'procedures section missing').toContain('Procedures:');
  });
});

// ── hooks ───────────────────────────────────────────────────────────────────

describe('before_agent_start (auto-recall) against the live server', () => {
  test('prepends real recalled memory', async () => {
    const out = await harness.hooks.get('before_agent_start')!({
      prompt: RECALL_QUERY,
      sessionId: `sess-${randomUUID()}`,
    });
    expect(out?.prependContext).toContain('<relevant-memories source="elephant">');
    expect(out?.prependContext).toContain(MARKER);
    expect(out?.prependContext).toContain('</relevant-memories>');
  });

  test('a blank prompt short-circuits without a request', async () => {
    expect(await harness.hooks.get('before_agent_start')!({ prompt: '   ' })).toBeUndefined();
  });

  // Recall must never block the agent: a dead backend has to degrade to "no
  // injected context", not throw into the host's turn.
  test('an unreachable server is swallowed, not thrown', async () => {
    const dead = makeFakeApi({
      // Reserved TEST-NET-1 with a closed port: connects nowhere, fails fast
      // enough for the hook's own 5s timeout to matter.
      url: 'http://127.0.0.1:1',
      token: TOKEN,
      agentId: AGENT,
    });
    plugin.register(dead.api);
    await expect(
      dead.hooks.get('before_agent_start')!({ prompt: RECALL_QUERY }),
    ).resolves.toBeUndefined();
  });
});

describe('agent_end (auto-capture) against the live server', () => {
  test('the turn transcript lands as a real Episode', async () => {
    const sessionId = `sess-${randomUUID()}`;
    const marker = `capture-${randomUUID()}`;
    const since = new Date(Date.now() - 60_000);
    await harness.hooks.get('agent_end')!({
      agentId: AGENT,
      sessionId,
      messages: [
        { role: 'user', content: `${marker} remember that deploys moved to thursday please` },
        {
          role: 'assistant',
          content: [{ text: 'Noted — deploys now happen on Thursday from here on.' }],
        },
      ],
    });
    const episodes = await read((tx) => EpisodeRepository.listSince(tx, since));
    const mine = episodes.find((e) => e.rawTranscript.includes(marker));
    expect(mine, 'agent_end did not persist an episode').toBeDefined();
    expect(mine!.sessionId).toBe(sessionId);
    expect(mine!.agentId).toBe(AGENT);
    expect(mine!.rawTranscript).toContain('USER: ');
    expect(mine!.rawTranscript).toContain('ASSISTANT: Noted');
  });

  test('a trivial turn is not persisted', async () => {
    const since = new Date();
    await harness.hooks.get('agent_end')!({
      agentId: AGENT,
      sessionId: `sess-${randomUUID()}`,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const episodes = await read((tx) => EpisodeRepository.listSince(tx, since));
    expect(episodes.filter((e) => e.agentId === AGENT)).toHaveLength(0);
  });
});
