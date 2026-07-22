// Drives register() with a fake OpenClaw api object: records tool/CLI/hook
// registrations, then invokes the handlers against a stubbed fetch to assert
// elephant payloads, prependContext shape, and episode capture.

import { type MockInstance, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import plugin from '../index.ts';
import manifest from '../openclaw.plugin.json' with { type: 'json' };

interface RegisteredTool {
  name: string;
  description: string;
  // biome-ignore lint/suspicious/noExplicitAny: mirrors the host's untyped surface
  execute: (toolCallId: string, params: any) => Promise<{ content: Array<{ text: string }> }>;
}

// biome-ignore lint/suspicious/noExplicitAny: mirrors commander's fluent surface
type CliAction = (...args: any[]) => Promise<void>;

/** Minimal commander stand-in: records every `command()` path and its action so
 *  tests can both enumerate the CLI surface and invoke a leaf command. */
function makeFakeProgram() {
  const commands = new Map<string, { action?: CliAction }>();
  // biome-ignore lint/suspicious/noExplicitAny: fluent builder, self-referential
  function makeCmd(path: string): any {
    const self = {
      command(spec: string) {
        const child = `${path} ${spec}`.trim();
        commands.set(child, {});
        return makeCmd(child);
      },
      description(_d: string) {
        return self;
      },
      action(fn: CliAction) {
        const entry = commands.get(path);
        if (entry) entry.action = fn;
        return self;
      },
    };
    return self;
  }
  return { program: makeCmd(''), commands };
}

function makeFakeApi(config: Record<string, unknown>) {
  const tools = new Map<string, RegisteredTool>();
  // biome-ignore lint/suspicious/noExplicitAny: mirrors the host's untyped surface
  const hooks = new Map<string, (event: any) => Promise<any>>();
  const cli = makeFakeProgram();
  let cliRegistered = false;
  return {
    api: {
      pluginConfig: config,
      // biome-ignore lint/suspicious/noExplicitAny: host-supplied shape
      registerTool(tool: any, _opts?: unknown) {
        tools.set(tool.name, tool);
      },
      // biome-ignore lint/suspicious/noExplicitAny: host-supplied shape
      on(event: string, handler: (event: any) => Promise<any>) {
        hooks.set(event, handler);
      },
      // biome-ignore lint/suspicious/noExplicitAny: host-supplied shape
      registerCli(setup: (ctx: { program: any }) => void, _opts?: unknown) {
        cliRegistered = true;
        setup({ program: cli.program });
      },
    },
    tools,
    hooks,
    cliCommands: cli.commands,
    isCliRegistered: () => cliRegistered,
  };
}

/** `<query...>` (commander variadic) and the manifest's `<query>` are the same
 *  command; compare without the ellipsis. */
function normalizeCliName(name: string): string {
  return name.replace(/\.\.\./g, '');
}

const CONFIG = {
  url: 'http://elephant.test',
  token: 'tok-12345678',
  agentId: 'openclaw',
  userId: 'gg',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let fetchMock: MockInstance<typeof fetch>;

beforeEach(() => {
  fetchMock = vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('registration', () => {
  test('manifest identity and memory kind', () => {
    expect(plugin.id).toBe('memory-elephant');
    expect(plugin.kind).toBe('memory');
  });

  test('registers the full tool surface, both hooks, and the CLI', () => {
    const fake = makeFakeApi(CONFIG);
    plugin.register(fake.api);
    expect(Array.from(fake.tools.keys()).sort()).toEqual([
      'memory_audit',
      'memory_entity',
      'memory_forget',
      'memory_intention_cancel',
      'memory_intention_complete',
      'memory_intention_create',
      'memory_intention_due',
      'memory_intention_fired',
      'memory_intention_list',
      'memory_knowledge_delete',
      'memory_knowledge_get',
      'memory_knowledge_list',
      'memory_knowledge_save',
      'memory_knowledge_update',
      'memory_observe',
      'memory_preference_get',
      'memory_preference_set',
      'memory_procedure_delete',
      'memory_procedure_get',
      'memory_procedure_list',
      'memory_procedure_save',
      'memory_procedure_update',
      'memory_recall',
      'memory_research_delete',
      'memory_research_get',
      'memory_research_list',
      'memory_research_save',
      'memory_research_update',
      'memory_save',
      'memory_state_delete',
      'memory_state_get',
      'memory_state_list',
      'memory_state_set',
      'memory_timeline',
    ]);
    expect(Array.from(fake.hooks.keys()).sort()).toEqual(['agent_end', 'before_agent_start']);
    expect(fake.isCliRegistered()).toBe(true);
  });

  // The manifest is what the host reads to advertise the plugin; a tool that
  // exists in only one of the two places is invisible or a dead entry.
  test('manifest lists exactly the registered tools', () => {
    const fake = makeFakeApi(CONFIG);
    plugin.register(fake.api);
    expect(manifest.tools.map((t) => t.name).sort()).toEqual(Array.from(fake.tools.keys()).sort());
  });

  test('manifest lists exactly the registered CLI leaf commands', () => {
    const fake = makeFakeApi(CONFIG);
    plugin.register(fake.api);
    // Group commands ("elephant knowledge") have no action and aren't advertised.
    const leaves = Array.from(fake.cliCommands.entries())
      .filter(([, c]) => c.action)
      .map(([name]) => normalizeCliName(name))
      .sort();
    expect(manifest.cliCommands.map((c) => normalizeCliName(c.name)).sort()).toEqual(leaves);
  });

  test('hooks are not registered when disabled in config', () => {
    const fake = makeFakeApi({
      ...CONFIG,
      autoRecall: { enabled: false },
      autoCapture: { enabled: false },
    });
    plugin.register(fake.api);
    expect(fake.hooks.size).toBe(0);
  });

  test('missing token fails fast', () => {
    const fake = makeFakeApi({ url: 'http://elephant.test' });
    expect(() => plugin.register(fake.api)).toThrow(/token/);
  });
});

describe('tools', () => {
  test('memory_save posts scope and actor', async () => {
    const fake = makeFakeApi(CONFIG);
    plugin.register(fake.api);
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, data: { id: 'f1' } }));
    const result = await fake.tools.get('memory_save')!.execute('t1', {
      fact: 'user prefers espresso',
      category: 'preference',
    });
    expect(result.content[0]!.text).toContain('Saved fact f1');
    const body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string);
    expect(body).toEqual({
      content: 'user prefers espresso',
      category: 'preference',
      agentId: 'openclaw',
      userId: 'gg',
      actor: 'openclaw',
    });
  });

  test('memory_forget rejects non-UUID factId without a request', async () => {
    const fake = makeFakeApi(CONFIG);
    plugin.register(fake.api);
    const result = await fake.tools.get('memory_forget')!.execute('t1', { factId: '../dream' });
    expect(result.content[0]!.text).toBe('factId must be a UUID.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('memory_forget fuzzy path hard-filters to own agent scope', async () => {
    const fake = makeFakeApi(CONFIG);
    plugin.register(fake.api);
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, data: { facts: [] } }));
    await fake.tools.get('memory_forget')!.execute('t1', { query: 'old belief' });
    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.pathname).toBe('/recall');
    expect(url.searchParams.get('agentScope')).toBe('filter');
  });
});

describe('recall opt-ins', () => {
  const CATEGORIES = [
    'includePreferences',
    'includeInsights',
    'includeProcedures',
    'includeKnowledge',
    'includeResearch',
    'includeIntentions',
  ];

  // The tool, the auto-recall hook, and the CLI must issue the same query, or
  // the same prompt returns differently ranked memory depending on entry point.
  test('all three call sites request the same categories and scope modes', async () => {
    const fake = makeFakeApi(CONFIG);
    plugin.register(fake.api);
    // A Response body reads once — build a fresh one per call.
    fetchMock.mockImplementation(async () => jsonResponse({ ok: true, data: { facts: [] } }));

    await fake.tools.get('memory_recall')!.execute('t1', { query: 'coffee' });
    await fake.hooks.get('before_agent_start')!({ prompt: 'coffee' });
    await fake.cliCommands.get('elephant recall <query...>')!.action!(['coffee']);

    expect(fetchMock.mock.calls).toHaveLength(3);
    const [tool, hook, cli] = fetchMock.mock.calls.map(
      (call) => new URL(call[0] as string).searchParams,
    );
    for (const params of [tool!, hook!, cli!]) {
      for (const category of CATEGORIES) expect(params.get(category)).toBe('true');
      expect(params.get('agentScope')).toBe('boost');
      expect(params.get('sessionScope')).toBe('boost');
      expect(params.get('userScope')).toBe('boost');
      expect(params.get('projectScope')).toBe('none');
    }
    // The hook keeps its own configurable budget; tool and CLI share the default.
    expect(tool!.get('limit')).toBe('10');
    expect(cli!.get('limit')).toBe('10');
    expect(hook!.get('limit')).toBe('8');
  });
});

describe('formatting', () => {
  test('renders knowledge, research, and intention sections', async () => {
    const fake = makeFakeApi(CONFIG);
    plugin.register(fake.api);
    fetchMock.mockResolvedValue(
      jsonResponse({
        ok: true,
        data: {
          facts: [],
          knowledgeChunks: [{ documentId: 'k1', text: 'deploys run on thursday' }],
          research: [
            { id: 'r1', title: 'Coffee study', source: 'web', tags: [], summary: 'beans' },
          ],
          researchChunks: [{ researchId: 'r1', text: 'arabica outperforms' }],
          intentions: [{ id: 'i1', content: 'follow up friday', status: 'pending', dueAt: null }],
        },
      }),
    );
    const out = await fake.tools.get('memory_recall')!.execute('t1', { query: 'coffee' });
    const rendered = out.content[0]!.text;
    expect(rendered).toContain('Knowledge:\n- [k1] deploys run on thursday');
    expect(rendered).toContain('Research:\n- [r1] Coffee study (web) — beans');
    expect(rendered).toContain('Research excerpts:\n- [r1] arabica outperforms');
    expect(rendered).toContain('Intentions:\n- [i1] (pending) follow up friday');
  });
});

describe('project-scoped research', () => {
  test('refuses to call the API when projectId is unset', async () => {
    const fake = makeFakeApi(CONFIG);
    plugin.register(fake.api);
    for (const name of ['memory_research_list', 'memory_research_get', 'memory_research_save']) {
      const result = await fake.tools.get(name)!.execute('t1', {
        id: '00000000-0000-4000-8000-000000000000',
        title: 't',
        source: 's',
        content: 'c',
      });
      expect(result.content[0]!.text).toMatch(/project-scoped/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('passes the configured projectId through', async () => {
    const fake = makeFakeApi({ ...CONFIG, projectId: 'elephant' });
    plugin.register(fake.api);
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, data: [] }));
    await fake.tools.get('memory_research_list')!.execute('t1', {});
    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.pathname).toBe('/research');
    expect(url.searchParams.get('projectId')).toBe('elephant');
  });
});

describe('id validation', () => {
  test('every id-taking tool rejects a non-UUID without a request', async () => {
    const fake = makeFakeApi({ ...CONFIG, projectId: 'elephant' });
    plugin.register(fake.api);
    const idTools = [
      'memory_knowledge_get',
      'memory_knowledge_update',
      'memory_knowledge_delete',
      'memory_research_get',
      'memory_research_update',
      'memory_research_delete',
      'memory_procedure_get',
      'memory_procedure_update',
      'memory_procedure_delete',
      'memory_intention_complete',
      'memory_intention_cancel',
      'memory_intention_fired',
    ];
    for (const name of idTools) {
      const result = await fake.tools.get(name)!.execute('t1', { id: '../dream' });
      expect(result.content[0]!.text, name).toBe('id must be a UUID.');
    }
    const audit = await fake.tools.get('memory_audit')!.execute('t1', { targetId: '../dream' });
    expect(audit.content[0]!.text).toBe('targetId must be a UUID.');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('before_agent_start (auto-recall)', () => {
  test('prepends rendered memory when there are matches', async () => {
    const fake = makeFakeApi(CONFIG);
    plugin.register(fake.api);
    fetchMock.mockResolvedValue(
      jsonResponse({
        ok: true,
        data: {
          facts: [
            {
              id: 'f1',
              content: 'espresso wins',
              confidence: 0.9,
              importance: 0.7,
              validFrom: '2026-01-01T00:00:00Z',
              validTo: null,
              recordedAt: '2026-01-01T00:00:00Z',
              entities: [],
              score: 0.91,
            },
          ],
        },
      }),
    );
    const out = await fake.hooks.get('before_agent_start')!({
      prompt: 'what coffee do I like?',
      sessionId: 'telegram:42',
    });
    expect(out.prependContext).toContain('<relevant-memories source="elephant">');
    expect(out.prependContext).toContain('espresso wins');
    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.searchParams.get('sessionId')).toBe('telegram:42');
  });

  test('returns nothing on empty recall and swallows errors', async () => {
    const fake = makeFakeApi(CONFIG);
    plugin.register(fake.api);
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, data: { facts: [] } }));
    const empty = await fake.hooks.get('before_agent_start')!({ prompt: 'x' });
    expect(empty).toBeUndefined();

    fetchMock.mockRejectedValue(new Error('connection refused'));
    const failed = await fake.hooks.get('before_agent_start')!({ prompt: 'x' });
    expect(failed).toBeUndefined();
  });
});

describe('agent_end (auto-capture)', () => {
  test('flushes the turn transcript as an episode', async () => {
    const fake = makeFakeApi(CONFIG);
    plugin.register(fake.api);
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, data: { episodeId: 'e1' } }));
    await fake.hooks.get('agent_end')!({
      agentId: 'openclaw',
      sessionId: 'telegram:42',
      messages: [
        { role: 'user', content: 'remember that I switched the deploy day to thursday' },
        { role: 'assistant', content: 'Noted — deploys now happen on Thursday.' },
      ],
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://elephant.test/episodes');
    const body = JSON.parse(init?.body as string);
    expect(body.agentId).toBe('openclaw');
    expect(body.sessionId).toBe('telegram:42');
    expect(body.rawTranscript).toContain('USER: remember that I switched');
    expect(body.rawTranscript).toContain('ASSISTANT: Noted');
    expect(body.userId).toBe('gg');
  });

  test('skips trivial turns and injected memory blocks', async () => {
    const fake = makeFakeApi(CONFIG);
    plugin.register(fake.api);
    await fake.hooks.get('agent_end')!({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'system', content: '<relevant-memories source="elephant">…</relevant-memories>' },
      ],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
