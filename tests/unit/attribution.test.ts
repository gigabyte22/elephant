// resolveFactUserId decides which userId a dream-extracted fact scopes to.
// The rules are small but each guards a real failure mode: attribution only
// activates when the episode declares participants (single-user orchestrators
// stay unaffected even if a model emits `subject` unprompted), and nothing the
// model invents may move a fact into another human's bucket.

import { describe, expect, test } from 'vitest';
import { resolveFactUserId } from '../../src/models/types.ts';

const participants = [{ label: 'Alice', userId: 'u:alice' }, { label: 'bob' }];

describe('resolveFactUserId', () => {
  test('no participants: subject is ignored, episode userId inherited', () => {
    expect(resolveFactUserId({ userId: 'u:greg' }, { subject: 'alice' })).toBe('u:greg');
    expect(resolveFactUserId({ userId: 'u:greg', participants: [] }, { subject: null })).toBe(
      'u:greg',
    );
  });

  test('subject null: shared bucket', () => {
    expect(
      resolveFactUserId({ userId: 'u:greg', participants }, { subject: null }),
    ).toBeUndefined();
  });

  test('label match is case- and whitespace-insensitive', () => {
    expect(resolveFactUserId({ userId: 'u:greg', participants }, { subject: ' ALICE ' })).toBe(
      'u:alice',
    );
  });

  test('matched participant without a userId lands shared, not in the episode bucket', () => {
    // Scoping bob's facts into the posting user's personal bucket would be a
    // cross-user leak — the worse failure than losing the attribution.
    expect(
      resolveFactUserId({ userId: 'u:greg', participants }, { subject: 'bob' }),
    ).toBeUndefined();
  });

  test('unknown label falls back to the episode userId, never the shared bucket', () => {
    expect(resolveFactUserId({ userId: 'u:greg', participants }, { subject: 'charlie' })).toBe(
      'u:greg',
    );
  });

  test('missing subject: legacy inheritance', () => {
    expect(resolveFactUserId({ userId: 'u:greg', participants }, {})).toBe('u:greg');
  });

  test('unscoped episode with participants still attributes', () => {
    expect(resolveFactUserId({ participants }, { subject: 'alice' })).toBe('u:alice');
    expect(resolveFactUserId({ participants }, { subject: 'charlie' })).toBeUndefined();
  });
});
