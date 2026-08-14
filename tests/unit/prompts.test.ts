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

  describe('participants', () => {
    const group = {
      ...episode,
      rawTranscript: 'USER(alice): hello\n\nUSER(bob): hey\n\nASSISTANT: hi both',
      participants: [{ label: 'alice', userId: 'u:alice' }, { label: 'bob' }],
    };

    test('lists labels and the subject instruction', () => {
      const p = buildExtractFactsUserPrompt(group, []);
      expect(p).toContain(
        'Participants (human speakers in this transcript, by label): alice, bob.',
      );
      expect(p).toContain('Attribute each fact\'s "subject"');
    });

    test('never leaks userId scope strings into the prompt', () => {
      const p = buildExtractFactsUserPrompt(group, []);
      expect(p).not.toContain('u:alice');
    });

    test('absent without participants, and never as a NOTE', () => {
      expect(buildExtractFactsUserPrompt(episode, [])).not.toContain('Participants');
      // The origin notes own the NOTE: prefix; the participants block must not
      // collide with the origin=user assertion above.
      expect(buildExtractFactsUserPrompt(group, [])).not.toContain('NOTE:');
    });

    test('composes with an origin note', () => {
      const p = buildExtractFactsUserPrompt({ ...group, origin: 'ingest' }, []);
      expect(p).toContain('ingested content');
      expect(p).toContain('Participants');
    });
  });
});
