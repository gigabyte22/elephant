import { describe, expect, test } from 'vitest';
import { lastSpeakerLabel, startsWithSpeakerLabel } from '../../src/utils/speaker-labels.ts';

describe('startsWithSpeakerLabel', () => {
  test.each([
    'USER: hello',
    'USER(alice): hello',
    'ASSISTANT: hi',
    'TOOL: {"ok":true}',
    'SYSTEM TRIGGER (CRON): tick',
    '  USER: leading whitespace',
  ])('%s → true', (text) => {
    expect(startsWithSpeakerLabel(text)).toBe(true);
  });

  test.each([
    'plain prose continuing a turn',
    'the USER: is mentioned mid-sentence',
    'USERS: not a label',
  ])('%s → false', (text) => {
    expect(startsWithSpeakerLabel(text)).toBe(false);
  });
});

describe('lastSpeakerLabel', () => {
  test('returns the final label across turns', () => {
    const t = 'USER(alice): hi\n\nASSISTANT: hello\n\nUSER(bob): question\ncontinued prose';
    expect(lastSpeakerLabel(t)).toBe('USER(bob)');
  });

  test('plain USER label', () => {
    expect(lastSpeakerLabel('USER: hi\n\nASSISTANT: hello')).toBe('ASSISTANT');
  });

  test('null when the text has no labels', () => {
    expect(lastSpeakerLabel('just prose with no turn markers')).toBeNull();
  });

  test('labels must start a line', () => {
    expect(lastSpeakerLabel('she said ASSISTANT: is not a turn')).toBeNull();
  });
});
