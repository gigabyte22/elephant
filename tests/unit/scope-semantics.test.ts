// One rule, three expressions: scopeFilterClause (Cypher pushdown), axisAllows
// (JS post-filter) and assertInScope (the id-addressed route guard) must agree
// on what 'filter' and 'strict' mean.
//
// They did not. SPEC.md says a null scope is a shared global that 'filter'
// still admits; axisAllows implemented that, scopeFilterClause emitted plain
// equality (excluding nulls), and 'strict' produced no clause at all. So the
// categories that use pushdown disagreed with facts, and strict mode got zero
// pushdown. The repo's own spec hedged around it:
//   "The unscoped procedure may or may not pass null-handling"

import { describe, expect, test } from 'vitest';
import { assertInScope, type ScopeGuardQuery } from '../../src/http/scope-guard.ts';
import type { ScopeMode } from '../../src/models/types.ts';
import { scopeFilterClause } from '../../src/repositories/scope.ts';
import { axisAllows } from '../../src/services/retrieval/stages/PostFilterStage.ts';
import {
  buildRetrievalScope,
  PROJECT_USER_AXES,
} from '../../src/services/retrieval/stages/scope-helpers.ts';
import type { RecallQuery } from '../../src/services/retrieval/types.ts';

// Evaluate the emitted Cypher against a row. A tiny interpreter rather than a
// string match, so the assertion is about MEANING and survives harmless
// formatting changes. Both shapes the builder can produce reduce to:
//   no clause          → admits everything
//   null item value    → admitted only if the clause has an IS NULL branch
//   non-null           → admitted only if it equals the bound query value
function evaluateClause(clause: string, itemValue: string | null, queryValue: string): boolean {
  if (clause === '') return true;
  if (itemValue === null) return clause.includes('IS NULL');
  return itemValue === queryValue;
}

describe('scopeFilterClause and axisAllows agree', () => {
  const modes: ScopeMode[] = ['boost', 'filter', 'strict', 'none'];
  const itemValues: Array<string | null> = [null, 'p1', 'p2'];

  for (const mode of modes) {
    for (const itemValue of itemValues) {
      test(`mode=${mode} item=${itemValue ?? 'null'}`, () => {
        const { clause } = scopeFilterClause('node', {
          projectId: 'p1',
          projectScope: mode,
        });

        expect(evaluateClause(clause, itemValue, 'p1')).toBe(axisAllows(itemValue, 'p1', mode));
      });
    }
  }
});

describe('emitted clause shape per mode', () => {
  test("'filter' admits nulls as shared globals", () => {
    const { clause, params } = scopeFilterClause('node', {
      projectId: 'p1',
      projectScope: 'filter',
    });
    expect(clause).toBe('(node.projectId = $scope_projectId OR node.projectId IS NULL)');
    expect(params).toEqual({ scope_projectId: 'p1' });
  });

  test("'strict' excludes nulls", () => {
    const { clause } = scopeFilterClause('node', { projectId: 'p1', projectScope: 'strict' });
    expect(clause).toBe('node.projectId = $scope_projectId');
  });

  test("'boost' and 'none' push nothing down", () => {
    expect(scopeFilterClause('node', { projectId: 'p1', projectScope: 'boost' }).clause).toBe('');
    expect(scopeFilterClause('node', { projectId: 'p1', projectScope: 'none' }).clause).toBe('');
  });

  test('an axis with no value pushes nothing down regardless of mode', () => {
    expect(scopeFilterClause('node', { projectScope: 'strict' }).clause).toBe('');
  });

  test('multiple filtering axes are ANDed', () => {
    const { clause } = scopeFilterClause('node', {
      projectId: 'p1',
      projectScope: 'strict',
      userId: 'u1',
      userScope: 'strict',
    });
    expect(clause).toBe('node.projectId = $scope_projectId AND node.userId = $scope_userId');
  });
});

describe('buildRetrievalScope projects only the axes a node type carries', () => {
  const query = {
    projectId: 'p1',
    userId: 'u1',
    agentId: 'a1',
    sessionId: 's1',
    projectScope: 'filter',
    userScope: 'filter',
    agentScope: 'filter',
    sessionScope: 'filter',
  } as unknown as RecallQuery;

  test('defaults to all four axes', () => {
    const scope = buildRetrievalScope(query);
    expect(scope).toMatchObject({ projectId: 'p1', userId: 'u1', agentId: 'a1', sessionId: 's1' });
  });

  // :Procedure, :KnowledgeChunk, :ResearchChunk and :Research have no
  // agentId/sessionId. Pushing those axes emitted `node.sessionId = $v`
  // against a label that lacks the property, which matches nothing — so
  // sessionScope=filter silently returned an empty list.
  test('drops agent and session for project/user-only node types', () => {
    const scope = buildRetrievalScope(query, PROJECT_USER_AXES);
    expect(scope.projectId).toBe('p1');
    expect(scope.userId).toBe('u1');
    expect(scope.agentId).toBeUndefined();
    expect(scope.sessionId).toBeUndefined();
    expect(scope.agentScope).toBeUndefined();
    expect(scope.sessionScope).toBeUndefined();
  });

  test('a dropped axis therefore pushes no predicate', () => {
    const scope = buildRetrievalScope(query, PROJECT_USER_AXES);
    const { clause } = scopeFilterClause('node', scope);
    expect(clause).not.toContain('sessionId');
    expect(clause).not.toContain('agentId');
  });
});

// The third expression. assertInScope guards id-addressed routes rather than
// retrieval, so it takes no mode: it is hard-wired to 'filter' semantics, which
// makes it exactly comparable to axisAllows(..., 'filter'). The first two drifted
// once; this pins the third to them before it can.
describe("assertInScope agrees with axisAllows in 'filter' mode", () => {
  const axes = ['projectId', 'userId'] as const;
  type Axis = (typeof axes)[number];
  const itemValues: Array<string | null> = [null, 'p1', 'p2'];
  // undefined = the caller declared no scope, which must stay unrestricted.
  const queryValues: Array<string | undefined> = [undefined, 'p1'];

  // An absent key is how both sides say "no scope on this axis": a null column
  // on the item, an undeclared scope on the query.
  function onAxis(axis: Axis, value: string | null | undefined): ScopeGuardQuery {
    if (value == null) return {};
    return axis === 'projectId' ? { projectId: value } : { userId: value };
  }

  function guardAdmits(
    axis: Axis,
    itemValue: string | null,
    queryValue: string | undefined,
  ): boolean {
    try {
      assertInScope(onAxis(axis, itemValue), onAxis(axis, queryValue), 'item');
      return true;
    } catch {
      return false;
    }
  }

  for (const axis of axes) {
    for (const queryValue of queryValues) {
      for (const itemValue of itemValues) {
        test(`${axis} query=${queryValue ?? 'none'} item=${itemValue ?? 'null'}`, () => {
          expect(guardAdmits(axis, itemValue, queryValue)).toBe(
            axisAllows(itemValue, queryValue, 'filter'),
          );
        });
      }
    }
  }

  test('the guard is filter, never strict: an unscoped item stays reachable', () => {
    expect(axisAllows(null, 'p1', 'strict')).toBe(false);
    expect(guardAdmits('projectId', null, 'p1')).toBe(true);
  });

  test('a missing item is refused, and indistinguishably from a cross-scope one', () => {
    expect(() => assertInScope(null, { projectId: 'p1' }, 'item')).toThrow();
    expect(() => assertInScope({ projectId: 'p2' }, { projectId: 'p1' }, 'item')).toThrow();
  });
});
