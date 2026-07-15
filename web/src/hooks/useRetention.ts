import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client.ts';
import type { RetentionPayload } from '../api/types.ts';
import type { Scope } from '../lib/scope.ts';

export function useRetention(scope: Scope) {
  return useQuery({
    queryKey: ['retention', scope],
    queryFn: ({ signal }) =>
      apiGet<RetentionPayload>('/facts/retention', { search: scope, signal }),
    staleTime: 30_000,
  });
}
