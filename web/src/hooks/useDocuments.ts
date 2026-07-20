import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client.ts';
import type { DocumentSort, DocumentsPayload, NarrativeKind } from '../api/types.ts';
import type { Scope } from '../lib/scope.ts';

// The documents ledger — research + knowledge documents, the only index that
// makes these reachable without stumbling onto them in the graph.

interface Args {
  scope: Scope;
  kind?: NarrativeKind;
  q?: string;
  sort?: DocumentSort;
  limit?: number;
  offset?: number;
}

export function useDocuments({ scope, kind, q, sort = 'recent', limit = 50, offset = 0 }: Args) {
  return useQuery({
    queryKey: ['documents', kind, q, sort, limit, offset, scope],
    queryFn: ({ signal }) =>
      apiGet<DocumentsPayload>('/documents', {
        search: { ...scope, kind, q, sort, limit, offset },
        signal,
      }),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}
