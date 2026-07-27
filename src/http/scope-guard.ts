import { z } from 'zod';
import { notFound } from './errors.ts';

// Scope declared by the caller on an id-addressed request.
export const ScopeGuardQuery = z.object({
  projectId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
});
export type ScopeGuardQuery = z.infer<typeof ScopeGuardQuery>;

/**
 * Enforce that an id-addressed item belongs to the caller's declared scope.
 *
 * Auth is a single shared bearer token, so scope is the only thing separating
 * one orchestrator's memory from another's — yet it was applied inconsistently
 * on the write paths. `GET /research/:id` and `PUT /research/:id` guarded;
 * `DELETE /research/:id` did not, and the procedure and knowledge mutations had
 * no guard at all. Any caller holding the token could delete or overwrite any
 * project's memory by id.
 *
 * Semantics deliberately match the original research implementation:
 *
 *  - A mismatch is reported as 404, never 403. Existence is itself scoped — a
 *    403 would confirm the id exists in some other project.
 *  - An item with no scope is a shared global and stays reachable. Only a
 *    CROSS-scope access is refused, mirroring `filter` rather than `strict`.
 *  - A caller that declares no scope is unrestricted, which keeps the
 *    single-tenant default working. Real isolation needs per-key scope binding
 *    at the auth layer; this closes the gap where a caller that DOES declare
 *    its scope could still reach outside it.
 */
export function assertInScope<T extends { projectId?: string; userId?: string }>(
  item: T | null | undefined,
  query: ScopeGuardQuery,
  describe: string,
): T {
  if (!item) throw notFound(describe);
  if (query.projectId && item.projectId && item.projectId !== query.projectId) {
    throw notFound(describe);
  }
  if (query.userId && item.userId && item.userId !== query.userId) {
    throw notFound(describe);
  }
  return item;
}
