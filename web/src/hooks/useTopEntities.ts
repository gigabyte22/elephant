import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client.ts';
import type { TopEntitiesPayload } from '../api/types.ts';
import type { Scope } from '../lib/scope.ts';

interface Args {
  scope: Scope;
  limit?: number;
}

export function useTopEntities({ scope, limit = 100 }: Args) {
  return useQuery({
    queryKey: ['top-entities', limit, scope],
    queryFn: ({ signal }) =>
      apiGet<TopEntitiesPayload>('/entities/top', {
        search: { ...scope, limit },
        signal,
      }),
    staleTime: 15_000,
  });
}
