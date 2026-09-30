import type {
  ExtractionInput,
  ExtractionResult,
  ExtractionService,
} from '../adapters/extraction/types.ts';
import { type Env, EnvSchema, EnvValidationError, parseEnv } from '../config/env.ts';
import type { SettingsStore } from './secure-store.ts';

// Runtime-editable vision/transcription settings. Resolution order at use time:
// stored value → process env → the schema's built-in default. The effective env
// is the real EnvSchema run over `{ ...process.env, ...stored }`, so a stored
// value is validated by exactly the rules the env loader applies.

// Derived from the schema so a new KNOWLEDGE_VISION_* / KNOWLEDGE_TRANSCRIBE_*
// var is editable (and tested) without touching this file.
export const KNOWLEDGE_MEDIA_SETTING_NAMES: readonly string[] = Object.keys(
  EnvSchema.innerType().shape,
).filter((k) => k.startsWith('KNOWLEDGE_VISION_') || k.startsWith('KNOWLEDGE_TRANSCRIBE_'));

function isSecret(name: string): boolean {
  return name.endsWith('_API_KEY');
}

export interface SettingStatus {
  name: string;
  secret: boolean;
  isSet: boolean;
  /** Never present for a secret. */
  value?: string;
  source: 'stored' | 'env' | 'default';
}

export interface SettingsPatch {
  set?: Record<string, string>;
  unset?: string[];
}

export class SettingsValidationError extends Error {}

export interface KnowledgeMediaSettings {
  /** Stable ExtractionService that always delegates to the current build. */
  extraction: ExtractionService;
  /** The env with stored values applied — what the current clients were built from. */
  effectiveEnv(): Env;
  list(): SettingStatus[];
  update(patch: SettingsPatch): SettingStatus[];
}

export function createKnowledgeMediaSettings(deps: {
  store: SettingsStore;
  build: (env: Env) => ExtractionService;
  /** Injected in place of the built service (tests, `ContainerOverrides`). */
  initial?: ExtractionService;
  baseEnv?: () => Record<string, string | undefined>;
}): KnowledgeMediaSettings {
  const baseEnv = deps.baseEnv ?? (() => process.env);
  const names = new Set(KNOWLEDGE_MEDIA_SETTING_NAMES);

  function mediaOnly(all: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(all).filter(([k]) => names.has(k)));
  }

  function withoutMedia(all: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(all).filter(([k]) => !names.has(k)));
  }

  function envWith(stored: Record<string, string>): Env {
    return parseEnv({ ...baseEnv(), ...stored });
  }

  let stored: Record<string, string> = {};
  try {
    stored = mediaOnly(deps.store.load());
  } catch (err) {
    // A store we cannot read must not stop the service booting on env alone.
    // eslint-disable-next-line no-console
    console.error('[settings] could not read stored settings; using env only', err);
  }
  let current = deps.initial ?? deps.build(envWith(stored));

  const extraction: ExtractionService = {
    extract: (input: ExtractionInput): Promise<ExtractionResult> => current.extract(input),
  };

  function sourceOf(
    name: string,
    fromEnv: Record<string, string | undefined>,
  ): SettingStatus['source'] {
    if (name in stored) return 'stored';
    if (fromEnv[name]) return 'env';
    return 'default';
  }

  function list(): SettingStatus[] {
    const effective = envWith(stored) as Record<string, unknown>;
    const fromEnv = baseEnv();
    return KNOWLEDGE_MEDIA_SETTING_NAMES.map((name) => {
      const secret = isSecret(name);
      const source = sourceOf(name, fromEnv);
      const status: SettingStatus = { name, secret, isSet: source !== 'default', source };
      const value = effective[name];
      if (!secret && value !== undefined) status.value = String(value);
      return status;
    });
  }

  function validatePatch(set: Record<string, string>, unset: string[]): void {
    for (const name of [...Object.keys(set), ...unset]) {
      if (!names.has(name)) throw new SettingsValidationError(`unknown setting: ${name}`);
    }
    const both = unset.filter((n) => n in set);
    if (both.length > 0) {
      throw new SettingsValidationError(`setting in both set and unset: ${both.join(', ')}`);
    }
    const empty = Object.entries(set).filter(([, v]) => v.trim() === '');
    if (empty.length > 0) {
      throw new SettingsValidationError(
        `empty value for ${empty.map(([n]) => n).join(', ')} (use unset to clear)`,
      );
    }
  }

  function update({ set = {}, unset = [] }: SettingsPatch): SettingStatus[] {
    validatePatch(set, unset);
    // Re-read so a second writer (another process) is merged, not clobbered.
    const all = deps.store.load();
    const next = { ...mediaOnly(all), ...set };
    for (const name of unset) delete next[name];

    let env: Env;
    try {
      env = envWith(next);
    } catch (err) {
      if (err instanceof EnvValidationError) throw new SettingsValidationError(err.message);
      throw err;
    }
    const rebuilt = deps.build(env);
    // The store holds only what this slice owns; keep anything else in it.
    deps.store.save({ ...withoutMedia(all), ...next });
    stored = next;
    current = rebuilt;
    return list();
  }

  return { extraction, effectiveEnv: () => envWith(stored), list, update };
}
