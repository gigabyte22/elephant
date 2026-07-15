import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client.ts';
import type { FactSort, TopFactsPayload } from '../api/types.ts';
import type { Scope } from '../lib/scope.ts';

interface Args {
  scope: Scope;
  sort?: FactSort;
  limit?: number;
  offset?: number;
  q?: string;
  category?: string;
}

export function useTopFacts({ scope, sort = 'refs', limit = 20, offset = 0, q, category }: Args) {
  return useQuery({
    queryKey: ['top-facts', sort, limit, offset, q, category, scope],
    queryFn: ({ signal }) =>
      apiGet<TopFactsPayload>('/facts/top', {
        search: { ...scope, sort, limit, offset, q, category },
        signal,
      }),
    // Keep the previous page rendered while the next one loads so pagination
    // and typing in the search box don't flash empty states.
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}
