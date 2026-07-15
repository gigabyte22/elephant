import { useMemo } from 'react';
import { useLocation } from 'wouter';
import { parseScope } from '../lib/scope.ts';
import type { Scope } from '../lib/scope.ts';

// Reads the scope filter out of the current location's query string.
// Wouter's useLocation returns just the path; we read window.location.search
// directly because it's the authoritative source for query params and Wouter
// preserves it across navigations.

export function useScope(): Scope {
  const [path] = useLocation();
  // Recomputes on every navigation. Cheap.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `path` is the intentional trigger — window.location.search isn't reactive
  return useMemo(() => parseScope(window.location.search), [path]);
}
