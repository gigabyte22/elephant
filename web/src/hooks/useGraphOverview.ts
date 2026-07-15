import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client.ts';
import type { GraphOverviewPayload } from '../api/types.ts';

export function useGraphOverview(maxNodes = 1200, enabled = true, excludeKinds: string[] = []) {
  // Server-side kind exclusion: comma-joined so it survives URLSearchParams and
  // the backend can split it. Folded into the query key so toggling raw layers
  // refetches a balanced snapshot instead of filtering a chunk-heavy one client-side.
  const exclude = excludeKinds.join(',');
  return useQuery({
    queryKey: ['graph-overview', maxNodes, exclude],
    queryFn: ({ signal }) =>
      apiGet<GraphOverviewPayload>('/graph/overview', {
        search: { maxNodes, excludeKinds: exclude || undefined },
        signal,
      }),
    enabled,
    staleTime: 60_000,
  });
}
