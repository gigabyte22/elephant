// Runtime-editable vision/transcription settings: encrypted store, resolution
// order (stored → env → default), hot reload of the extraction clients, and the
// authenticated admin routes that front them.

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExtractionService } from '../../src/adapters/extraction/types.ts';
import { resolveVisionTarget } from '../../src/adapters/factory.ts';
import { type Env, EnvSchema } from '../../src/config/env.ts';
import { bearerAuth } from '../../src/http/auth.ts';
import { errorHandler } from '../../src/http/errors.ts';
import { registerAdminSettingsRoutes } from '../../src/http/routes/admin-settings.ts';
import type { Container } from '../../src/index.ts';
import {
  createKnowledgeMediaSettings,
  KNOWLEDGE_MEDIA_SETTING_NAMES,
  SettingsValidationError,
} from '../../src/settings/knowledge-media.ts';
import { createSettingsStore } from '../../src/settings/secure-store.ts';

const TOKEN = 'test-service-token';
const SECRET = 'sk-super-secret-value';

const BASE_ENV = {
  MEMORY_SERVICE_TOKEN: TOKEN,
  NEO4J_PASSWORD: 'x',
  ANTHROPIC_API_KEY: 'sk-ant-dreaming',
  OPENAI_API_KEY: 'sk-oai-embeddings',
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elephant-settings-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// `build` records the env each client set was built from, so a test can see
// which key the "live" client holds.
function makeSettings(env: Record<string, string | undefined> = {}, storeKey?: string) {
  const built: Env[] = [];
  const settings = createKnowledgeMediaSettings({
    store: createSettingsStore(dir, storeKey),
    baseEnv: () => ({ ...BASE_ENV, ...env }),
    build: (e): ExtractionService => {
      built.push(e);
      return {
        extract: async () => {
          return { status: 'done', text: e.KNOWLEDGE_VISION_API_KEY ?? '', detail: '' };
        },
      };
    },
  });
  return { settings, built };
}

describe('setting names', () => {
  it('cover every KNOWLEDGE_VISION_* / KNOWLEDGE_TRANSCRIBE_* var in the env schema', () => {
    const fromSchema = Object.keys(EnvSchema.innerType().shape).filter(
      (k) => k.startsWith('KNOWLEDGE_VISION_') || k.startsWith('KNOWLEDGE_TRANSCRIBE_'),
    );
    expect([...KNOWLEDGE_MEDIA_SETTING_NAMES].sort()).toEqual(fromSchema.sort());
    expect(KNOWLEDGE_MEDIA_SETTING_NAMES).toContain('KNOWLEDGE_VISION_API_KEY');
    expect(KNOWLEDGE_MEDIA_SETTING_NAMES).toContain('KNOWLEDGE_TRANSCRIBE_MODEL');
  });
});

describe('encrypted store', () => {
  it('round-trips and never writes plaintext to disk', () => {
    const store = createSettingsStore(dir);
    store.save({ KNOWLEDGE_VISION_API_KEY: SECRET });
    expect(store.load()).toEqual({ KNOWLEDGE_VISION_API_KEY: SECRET });
    for (const f of readdirSync(dir)) {
      expect(readFileSync(join(dir, f), 'utf8')).not.toContain(SECRET);
    }
    expect(readFileSync(join(dir, 'settings.enc'), 'utf8')).not.toContain('KNOWLEDGE_VISION');
  });

  it('writes the store and the generated key file at mode 0600', () => {
    createSettingsStore(dir).save({ A: 'b' });
    expect(statSync(join(dir, 'settings.enc')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'settings.key')).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('returns {} without creating a key when nothing was ever stored', () => {
    expect(createSettingsStore(dir).load()).toEqual({});
    expect(readdirSync(dir)).toEqual([]);
  });

  it('uses ELEPHANT_SETTINGS_KEY (base64 or hex) instead of a key file', () => {
    const raw = Buffer.alloc(32, 7);
    for (const key of [raw.toString('base64'), raw.toString('hex')]) {
      const store = createSettingsStore(dir, key);
      store.save({ A: 'b' });
      expect(store.load()).toEqual({ A: 'b' });
    }
    expect(readdirSync(dir)).not.toContain('settings.key');
    // A different key cannot read it (GCM auth fails).
    expect(() => createSettingsStore(dir, Buffer.alloc(32, 9).toString('hex')).load()).toThrow();
  });

  it('rejects a key of the wrong length', () => {
    expect(() => createSettingsStore(dir, 'tooshort').save({})).toThrow(/32 bytes/);
  });

  it('detects tampering', () => {
    const store = createSettingsStore(dir);
    store.save({ A: 'b' });
    const path = join(dir, 'settings.enc');
    const file = JSON.parse(readFileSync(path, 'utf8'));
    file.data = Buffer.from('tampered-ciphertext').toString('base64');
    writeFileSync(path, JSON.stringify(file));
    expect(() => store.load()).toThrow();
  });
});

describe('resolution order and listing', () => {
  it('reports default, then env, then stored as the source', () => {
    const a = makeSettings().settings.list();
    const row = (list: typeof a, n: string) => list.find((s) => s.name === n);
    expect(row(a, 'KNOWLEDGE_VISION_MODEL')).toMatchObject({ source: 'default', isSet: false });
    expect(row(a, 'KNOWLEDGE_TRANSCRIBE_MODEL')).toMatchObject({
      source: 'default',
      isSet: false,
      value: 'whisper-1',
    });

    const b = makeSettings({ KNOWLEDGE_VISION_MODEL: 'env-model' });
    expect(row(b.settings.list(), 'KNOWLEDGE_VISION_MODEL')).toMatchObject({
      source: 'env',
      isSet: true,
      value: 'env-model',
    });

    b.settings.update({ set: { KNOWLEDGE_VISION_MODEL: 'stored-model' } });
    expect(row(b.settings.list(), 'KNOWLEDGE_VISION_MODEL')).toMatchObject({
      source: 'stored',
      value: 'stored-model',
    });
    expect(b.settings.effectiveEnv().KNOWLEDGE_VISION_MODEL).toBe('stored-model');

    b.settings.update({ unset: ['KNOWLEDGE_VISION_MODEL'] });
    expect(row(b.settings.list(), 'KNOWLEDGE_VISION_MODEL')).toMatchObject({
      source: 'env',
      value: 'env-model',
    });
  });

  it('keeps env working unchanged when nothing is stored', () => {
    const { settings } = makeSettings({ KNOWLEDGE_VISION_API_KEY: 'from-env' });
    expect(settings.effectiveEnv().KNOWLEDGE_VISION_API_KEY).toBe('from-env');
  });

  it('never returns a secret value, whatever its source', () => {
    const { settings } = makeSettings({ KNOWLEDGE_VISION_FALLBACK_API_KEY: 'env-secret' });
    settings.update({ set: { KNOWLEDGE_VISION_API_KEY: SECRET } });
    const list = settings.list();
    const secrets = list.filter((s) => s.secret).map((s) => s.name);
    expect(secrets).toEqual([
      'KNOWLEDGE_VISION_API_KEY',
      'KNOWLEDGE_VISION_FALLBACK_API_KEY',
      'KNOWLEDGE_TRANSCRIBE_API_KEY',
    ]);
    expect(
      list
        .filter((s) => s.secret)
        .every((s) => s.isSet === (s.name !== 'KNOWLEDGE_TRANSCRIBE_API_KEY')),
    ).toBe(true);
    const json = JSON.stringify(list);
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain('env-secret');
    expect(list.filter((s) => s.secret).every((s) => !('value' in s))).toBe(true);
  });

  it('survives a restart: a new instance reads what the old one stored', () => {
    makeSettings().settings.update({ set: { KNOWLEDGE_VISION_API_KEY: SECRET } });
    expect(makeSettings().settings.effectiveEnv().KNOWLEDGE_VISION_API_KEY).toBe(SECRET);
  });
});

describe('update validation', () => {
  it('rejects unknown names, including real env vars outside the allowed set', () => {
    const { settings } = makeSettings();
    expect(() => settings.update({ set: { NEO4J_PASSWORD: 'x' } })).toThrow(
      SettingsValidationError,
    );
    expect(() => settings.update({ unset: ['MEMORY_SERVICE_TOKEN'] })).toThrow(/unknown setting/);
  });

  it('rejects values the env schema rejects and persists nothing', () => {
    const { settings } = makeSettings();
    const bad: Record<string, string>[] = [
      { KNOWLEDGE_VISION_PROVIDER: 'bogus' },
      { KNOWLEDGE_VISION_BASE_URL: 'not a url' },
      { KNOWLEDGE_VISION_TIMEOUT_MS: '-5' },
      { KNOWLEDGE_VISION_JPEG_QUALITY: '101' },
    ];
    for (const set of bad) {
      expect(() => settings.update({ set })).toThrow(SettingsValidationError);
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it('rejects cross-field violations (provider=anthropic with no Anthropic key)', () => {
    const { settings } = makeSettings({
      ANTHROPIC_API_KEY: undefined,
      MEMORY_LLM_PROVIDER: 'openai',
    });
    expect(() => settings.update({ set: { KNOWLEDGE_VISION_PROVIDER: 'anthropic' } })).toThrow(
      /ANTHROPIC_API_KEY required/,
    );
    expect(() => settings.update({ set: { KNOWLEDGE_VISION_PROVIDER: 'none' } })).not.toThrow();
  });

  it('rejects empty values and set+unset of the same name', () => {
    const { settings } = makeSettings();
    expect(() => settings.update({ set: { KNOWLEDGE_VISION_MODEL: ' ' } })).toThrow(/unset/);
    expect(() =>
      settings.update({
        set: { KNOWLEDGE_VISION_MODEL: 'm' },
        unset: ['KNOWLEDGE_VISION_MODEL'],
      }),
    ).toThrow(/both/);
  });
});

describe('hot reload', () => {
  it('the stable extraction handle picks up a new key without a restart', async () => {
    const { settings, built } = makeSettings({ KNOWLEDGE_VISION_API_KEY: 'old-key' });
    const input = { mimeType: 'image/png' } as never;
    expect((await settings.extraction.extract(input)).text).toBe('old-key');
    expect(built).toHaveLength(1);

    settings.update({ set: { KNOWLEDGE_VISION_API_KEY: 'new-key' } });
    expect(built).toHaveLength(2);
    expect((await settings.extraction.extract(input)).text).toBe('new-key');

    settings.update({ unset: ['KNOWLEDGE_VISION_API_KEY'] });
    expect((await settings.extraction.extract(input)).text).toBe('old-key');
  });

  it('applies a stored provider change to the real vision resolver', () => {
    const { settings } = makeSettings();
    expect(resolveVisionTarget(settings.effectiveEnv())).toBeNull();
    settings.update({ set: { KNOWLEDGE_VISION_BASE_URL: 'http://ollama:11434/v1' } });
    expect(resolveVisionTarget(settings.effectiveEnv())).toMatchObject({ provider: 'openai' });
  });

  it('keeps the old client when the update is rejected', async () => {
    const { settings, built } = makeSettings({ KNOWLEDGE_VISION_API_KEY: 'old-key' });
    expect(() => settings.update({ set: { KNOWLEDGE_VISION_PROVIDER: 'nope' } })).toThrow();
    expect(built).toHaveLength(1);
    expect((await settings.extraction.extract({} as never)).text).toBe('old-key');
  });
});

describe('admin routes', () => {
  function buildApp() {
    const { settings } = makeSettings();
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.setErrorHandler(errorHandler);
    app.addHook('preHandler', bearerAuth(TOKEN));
    registerAdminSettingsRoutes(app, { mediaSettings: settings } as unknown as Container);
    return app;
  }
  const auth = { authorization: `Bearer ${TOKEN}` };
  const url = '/admin/settings/knowledge-media';

  it('requires the service token', async () => {
    const app = buildApp();
    for (const method of ['GET', 'PUT'] as const) {
      const none = await app.inject({ method, url, payload: method === 'PUT' ? {} : undefined });
      expect(none.statusCode).toBe(401);
      const wrong = await app.inject({
        method,
        url,
        headers: { authorization: 'Bearer nope' },
        payload: method === 'PUT' ? {} : undefined,
      });
      expect(wrong.statusCode).toBe(401);
    }
  });

  it('GET lists every setting inside the standard envelope', async () => {
    const res = await buildApp().inject({ method: 'GET', url, headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.settings.map((s: { name: string }) => s.name)).toEqual(
      KNOWLEDGE_MEDIA_SETTING_NAMES,
    );
  });

  it('PUT stores a secret, returns the same shape, and GET never leaks it', async () => {
    const app = buildApp();
    const put = await app.inject({
      method: 'PUT',
      url,
      headers: auth,
      payload: { set: { KNOWLEDGE_VISION_API_KEY: SECRET, KNOWLEDGE_VISION_MODEL: 'qwen' } },
    });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({ method: 'GET', url, headers: auth });
    for (const res of [put, get]) {
      expect(res.body).not.toContain(SECRET);
      const rows = res.json().data.settings;
      expect(rows.find((s: { name: string }) => s.name === 'KNOWLEDGE_VISION_API_KEY')).toEqual({
        name: 'KNOWLEDGE_VISION_API_KEY',
        secret: true,
        isSet: true,
        source: 'stored',
      });
      expect(rows.find((s: { name: string }) => s.name === 'KNOWLEDGE_VISION_MODEL')).toMatchObject(
        {
          value: 'qwen',
          source: 'stored',
        },
      );
    }
  });

  it('PUT answers 400 for unknown names and bad values', async () => {
    const app = buildApp();
    for (const payload of [
      { set: { NEO4J_PASSWORD: 'x' } },
      { set: { KNOWLEDGE_VISION_PROVIDER: 'bogus' } },
      { set: { KNOWLEDGE_VISION_MODEL: 5 } },
    ]) {
      const res = await app.inject({ method: 'PUT', url, headers: auth, payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().ok).toBe(false);
    }
  });
});
