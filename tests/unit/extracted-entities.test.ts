import { describe, expect, test } from 'vitest';
import { ExtractedFactSchema, resolveExtractedEntities } from '../../src/models/types.ts';

// resolveExtractedEntities merges the typed `entities` list with any legacy
// flat `entityNames`, dedupes case/whitespace-insensitively, and defaults the
// type of bare names to 'Concept'.

function fact(overrides: Partial<{ entities: unknown; entityNames: unknown }>) {
  return ExtractedFactSchema.parse({
    content: 'x',
    confidence: 0.7,
    importance: 0.5,
    ...overrides,
  });
}

describe('resolveExtractedEntities', () => {
  test('keeps typed entities verbatim', () => {
    const f = fact({
      entities: [
        { name: 'Alice', type: 'person' },
        { name: 'deploy', type: 'tool' },
      ],
    });
    expect(resolveExtractedEntities(f)).toEqual([
      { name: 'Alice', type: 'person' },
      { name: 'deploy', type: 'tool' },
    ]);
  });

  test('back-compat: bare entityNames become Concept', () => {
    const f = fact({ entityNames: ['alice', 'theme'] });
    expect(resolveExtractedEntities(f)).toEqual([
      { name: 'alice', type: 'Concept' },
      { name: 'theme', type: 'Concept' },
    ]);
  });

  test('merges both, typed entry wins over duplicate bare name', () => {
    const f = fact({
      entities: [{ name: 'Alice', type: 'person' }],
      entityNames: ['alice', 'project-x'],
    });
    // "alice" duplicates the typed "Alice" (case-folded) and is dropped;
    // "project-x" survives as a Concept.
    expect(resolveExtractedEntities(f)).toEqual([
      { name: 'Alice', type: 'person' },
      { name: 'project-x', type: 'Concept' },
    ]);
  });

  test('defaults to empty when neither field present', () => {
    const f = fact({});
    expect(resolveExtractedEntities(f)).toEqual([]);
  });

  test('entity type defaults to Concept when omitted in typed list', () => {
    const f = fact({ entities: [{ name: 'thing' }] });
    expect(resolveExtractedEntities(f)).toEqual([{ name: 'thing', type: 'Concept' }]);
  });
});
