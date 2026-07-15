import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client.ts';
import type { StatsPayload } from '../api/types.ts';
import type { Scope } from '../lib/scope.ts';

export function useStats(scope: Scope) {
  return useQuery({
    queryKey: ['stats', scope],
    queryFn: ({ signal }) => apiGet<StatsPayload>('/stats', { search: scope, signal }),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
}
