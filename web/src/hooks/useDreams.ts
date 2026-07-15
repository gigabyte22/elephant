import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client.ts';
import type { DreamRunsPayload } from '../api/types.ts';

export function useDreams(limit = 50) {
  return useQuery({
    queryKey: ['dreams', limit],
    queryFn: ({ signal }) => apiGet<DreamRunsPayload>('/dreams', { search: { limit }, signal }),
    refetchInterval: 60_000,
    staleTime: 20_000,
  });
}
