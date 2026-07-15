import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client.ts';
import type { GraphSearchPayload } from '../api/types.ts';

export function useGraphSearch(q: string, limit = 20) {
  return useQuery({
    queryKey: ['graph-search', q, limit],
    queryFn: ({ signal }) =>
      apiGet<GraphSearchPayload>('/graph/search', {
        search: { q, limit },
        signal,
      }),
    enabled: q.trim().length > 0,
    staleTime: 30_000,
  });
}
