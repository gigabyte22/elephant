import { describe, expect, test } from 'vitest';
import { buildExtractFactsUserPrompt } from '../../src/adapters/llm/prompts.ts';

const episode = {
  sessionId: 'chan:greg',
  timestamp: new Date('2026-07-13T00:00:00Z'),
  rawTranscript: 'USER: hello\n\nASSISTANT: hi',
};

describe('buildExtractFactsUserPrompt', () => {
  test('includes session, timestamp, and transcript', () => {
    const p = buildExtractFactsUserPrompt(episode, []);
    expect(p).toContain('session=chan:greg');
    expect(p).toContain('2026-07-13T00:00:00.000Z');
    expect(p).toContain('USER: hello');
    expect(p).not.toContain('NOTE:');
  });

  test('lists existing facts when provided', () => {
    const p = buildExtractFactsUserPrompt(episode, [
      { id: '1', content: 'user lives in Edmonton' },
    ]);
    expect(p).toContain('avoid trivially restating');
    expect(p).toContain('- user lives in Edmonton');
  });

  test.each(['cron', 'event', 'system'] as const)(
    'origin=%s appends the autonomous-run note',
    (origin) => {
      const p = buildExtractFactsUserPrompt({ ...episode, origin }, []);
      expect(p).toContain('autonomous scheduled/triggered run');
      expect(p).toContain('Do not attribute actions or intents to "the user"');
    },
  );

  test('origin=ingest appends the ingested-content note', () => {
    const p = buildExtractFactsUserPrompt({ ...episode, origin: 'ingest' }, []);
    expect(p).toContain('ingested content');
    expect(p).toContain('Attribute claims to the content or its source');
  });

  test('origin=user adds no note', () => {
    const p = buildExtractFactsUserPrompt({ ...episode, origin: 'user' }, []);
    expect(p).not.toContain('NOTE:');
  });
});
