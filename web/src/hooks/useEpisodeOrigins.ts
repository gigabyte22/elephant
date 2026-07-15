import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client.ts';
import type { EpisodeOriginsPayload } from '../api/types.ts';
import type { Scope } from '../lib/scope.ts';

export function useEpisodeOrigins(scope: Scope) {
  return useQuery({
    queryKey: ['episode-origins', scope],
    queryFn: ({ signal }) =>
      apiGet<EpisodeOriginsPayload>('/episodes/origins', { search: scope, signal }),
    staleTime: 30_000,
  });
}
