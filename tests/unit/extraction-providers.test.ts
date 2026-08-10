import { describe, expect, it } from 'vitest';
import {
  describeExtractionCapabilities,
  resolveTranscribeTarget,
  resolveVisionTarget,
} from '../../src/adapters/factory.ts';
import type { Env } from '../../src/config/env.ts';

// Only the fields these resolvers read. The full Env is ~90 vars of unrelated
// configuration; casting a slice keeps each case to the two or three values it
// is actually about.
type ProviderEnv = Pick<
  Env,
  | 'KNOWLEDGE_VISION_PROVIDER'
  | 'KNOWLEDGE_TRANSCRIBE_PROVIDER'
  | 'KNOWLEDGE_TRANSCRIBE_MODEL'
  | 'ANTHROPIC_EXTRACTION_MODEL'
> &
  Partial<Env>;

const env = (over: Partial<ProviderEnv> = {}): Env =>
  ({
    KNOWLEDGE_VISION_PROVIDER: 'auto',
    KNOWLEDGE_TRANSCRIBE_PROVIDER: 'auto',
    KNOWLEDGE_TRANSCRIBE_MODEL: 'whisper-1',
    ANTHROPIC_EXTRACTION_MODEL: 'claude-sonnet-4-6',
    ...over,
  }) as Env;

describe('resolveVisionTarget', () => {
  it('stays off under auto when only the shared LLM keys are set', () => {
    // The regression this file exists for: ANTHROPIC_API_KEY is configured for
    // dreaming. It used to also enrol every uploaded image in an Anthropic
    // vision call, which is a decision nobody made.
    expect(resolveVisionTarget(env({ ANTHROPIC_API_KEY: 'sk-ant' }))).toBeNull();
    expect(resolveVisionTarget(env({ OPENAI_API_KEY: 'sk-oai' }))).toBeNull();
    expect(resolveVisionTarget(env({ OPENAI_BASE_URL: 'http://llm:8080/v1' }))).toBeNull();
  });

  it('turns on under auto for dedicated credentials', () => {
    expect(
      resolveVisionTarget(env({ KNOWLEDGE_VISION_BASE_URL: 'http://ollama:11434/v1' })),
    ).toEqual({ provider: 'openai', key: undefined, baseUrl: 'http://ollama:11434/v1' });
    expect(resolveVisionTarget(env({ KNOWLEDGE_VISION_API_KEY: 'sk-vision' }))).toMatchObject({
      provider: 'openai',
      key: 'sk-vision',
    });
  });

  it('lets an explicitly named provider spend the shared keys', () => {
    expect(
      resolveVisionTarget(
        env({ KNOWLEDGE_VISION_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant' }),
      ),
    ).toEqual({ provider: 'anthropic' });
    expect(
      resolveVisionTarget(env({ KNOWLEDGE_VISION_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-oai' })),
    ).toMatchObject({ provider: 'openai', key: 'sk-oai' });
  });

  it('prefers dedicated credentials over the shared pair', () => {
    expect(
      resolveVisionTarget(
        env({
          KNOWLEDGE_VISION_PROVIDER: 'openai',
          KNOWLEDGE_VISION_BASE_URL: 'http://ollama:11434/v1',
          OPENAI_BASE_URL: 'http://llm:8080/v1',
        }),
      ),
    ).toMatchObject({ baseUrl: 'http://ollama:11434/v1' });
  });

  it('stays off for none, and for a named provider with nothing to talk to', () => {
    expect(
      resolveVisionTarget(
        env({ KNOWLEDGE_VISION_PROVIDER: 'none', KNOWLEDGE_VISION_API_KEY: 'sk-vision' }),
      ),
    ).toBeNull();
    expect(resolveVisionTarget(env({ KNOWLEDGE_VISION_PROVIDER: 'anthropic' }))).toBeNull();
  });
});

describe('resolveTranscribeTarget', () => {
  it('applies the same opt-in rule as vision', () => {
    expect(resolveTranscribeTarget(env({ OPENAI_API_KEY: 'sk-oai' }))).toBeNull();
    expect(resolveTranscribeTarget(env({ KNOWLEDGE_TRANSCRIBE_API_KEY: 'sk-w' }))).toMatchObject({
      key: 'sk-w',
    });
    expect(
      resolveTranscribeTarget(
        env({ KNOWLEDGE_TRANSCRIBE_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-oai' }),
      ),
    ).toMatchObject({ key: 'sk-oai' });
    expect(resolveTranscribeTarget(env({ KNOWLEDGE_TRANSCRIBE_PROVIDER: 'none' }))).toBeNull();
  });
});

describe('describeExtractionCapabilities', () => {
  it('names the endpoint when on and the way to turn it on when off', () => {
    const [vision, audio] = describeExtractionCapabilities(env({ ANTHROPIC_API_KEY: 'sk-ant' }));
    expect(vision).toContain('disabled');
    expect(vision).toContain('KNOWLEDGE_VISION_*');
    expect(audio).toContain('disabled');

    const [visionOn] = describeExtractionCapabilities(
      env({ KNOWLEDGE_VISION_BASE_URL: 'http://ollama:11434/v1' }),
    );
    expect(visionOn).toContain('http://ollama:11434/v1');
    expect(visionOn).toContain('gpt-4o-mini');
  });
});
