// The redaction gate, and the two expressions of it that must not drift.
//
// Three lifecycle events close a fact's valid interval and only one hides
// history: supersede (world changed, event time), prune (system forgot,
// transaction time) and DELETE (redaction, invisible at every instant).
// `validTo` alone cannot say which, which is why `deletedAt` exists.

import { describe, expect, test } from 'vitest';
import { PostFilterStage } from '../../src/services/retrieval/stages/PostFilterStage.ts';
import type { FactCandidate } from '../../src/services/retrieval/types.ts';
import { isRedacted, notDeletedClause, validAtClause } from '../../src/utils/temporal.ts';
import { makeCtx, makeFact } from './retrieval-fixtures.ts';

describe('notDeletedClause', () => {
  test('is a plain IS NULL predicate on the given alias', () => {
    expect(notDeletedClause('node')).toBe('AND node.deletedAt IS NULL');
  });
});

describe('validAtClause emits the redaction gate in every branch', () => {
  const branches: Array<[string, { asOf: Date | null; includeSuperseded?: boolean }]> = [
    ['asOf only', { asOf: new Date('2026-03-01') }],
    ['asOf + includeSuperseded', { asOf: new Date('2026-03-01'), includeSuperseded: true }],
    ['live only', { asOf: null }],
    // The branch that used to return '' — exactly how ?includeSuperseded=1
    // resurrected user-deleted facts.
    ['includeSuperseded, no asOf', { asOf: null, includeSuperseded: true }],
  ];

  for (const [name, input] of branches) {
    test(name, () => {
      const clause = validAtClause('node', input);
      expect(clause).toContain('node.deletedAt IS NULL');
      // Every call site splices this after a mandatory WHERE, so a leading
      // AND must always be present — the empty-string branch is gone.
      expect(clause.trimStart().startsWith('AND ')).toBe(true);
    });
  }

  test('still filters to live rows when not asking for superseded history', () => {
    expect(validAtClause('node', { asOf: null })).toContain('node.validTo IS NULL');
  });

  test('does not filter validTo when includeSuperseded is set', () => {
    expect(validAtClause('node', { asOf: null, includeSuperseded: true })).not.toContain(
      'validTo IS NULL',
    );
  });
});

describe('isRedacted matches the Cypher predicate', () => {
  // The Cypher is `deletedAt IS NULL`; a missing property reads as NULL, so
  // undefined and null must both mean "not redacted".
  test.each([
    [undefined, false],
    [null, false],
    [new Date('2026-05-01'), true],
  ])('deletedAt=%s → redacted=%s', (deletedAt, expected) => {
    expect(isRedacted({ deletedAt: deletedAt as Date | null | undefined })).toBe(expected);
  });
});

describe('PostFilterStage drops redacted facts', () => {
  function runWith(fact: ReturnType<typeof makeFact>, query: Record<string, unknown>) {
    const state = {
      facts: new Map<string, FactCandidate>([
        [fact.id, { fact, sources: [], expansionReason: 'fact_vector', hasDirectHit: true }],
      ]),
      chunks: new Map(),
      preferences: new Map(),
      insights: new Map(),
      knowledgeChunks: new Map(),
      procedures: new Map(),
      research: new Map(),
      researchChunks: new Map(),
      intentions: new Map(),
      observations: new Map(),
    };
    const ctx = makeCtx({ query });
    return PostFilterStage()
      .run(ctx, state as never)
      .then((s) => (s as typeof state).facts);
  }

  const deleted = makeFact({
    id: '11111111-1111-4111-8111-111111111111',
    validFrom: new Date('2026-01-01'),
    validTo: new Date('2026-06-01'),
    deletedAt: new Date('2026-06-01'),
  });

  test('under includeSuperseded, which bypasses the validTo filter', async () => {
    await expect(runWith(deleted, { includeSuperseded: true })).resolves.toHaveProperty('size', 0);
  });

  test('at an asOf inside its former valid interval', async () => {
    await expect(
      runWith(deleted, { asOf: new Date('2026-03-01'), includeSuperseded: true }),
    ).resolves.toHaveProperty('size', 0);
  });

  test('but keeps a merely superseded fact at that same instant', async () => {
    const superseded = makeFact({
      id: '22222222-2222-4222-8222-222222222222',
      validFrom: new Date('2026-01-01'),
      validTo: new Date('2026-06-01'),
    });
    await expect(
      runWith(superseded, { asOf: new Date('2026-03-01'), includeSuperseded: true }),
    ).resolves.toHaveProperty('size', 1);
  });
});
