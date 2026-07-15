import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client.ts';
import type { FactCategoriesPayload } from '../api/types.ts';
import type { Scope } from '../lib/scope.ts';

export function useFactCategories(scope: Scope) {
  return useQuery({
    queryKey: ['fact-categories', scope],
    queryFn: ({ signal }) =>
      apiGet<FactCategoriesPayload>('/facts/categories', { search: scope, signal }),
    staleTime: 30_000,
  });
}
