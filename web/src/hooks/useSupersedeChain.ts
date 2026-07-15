import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client.ts';
import type { SupersedeChainPayload } from '../api/types.ts';

// Fetches the full supersede lineage for a fact (oldest → newest, including
// the fact itself). Pass null to keep the query idle (e.g. no row selected).
export function useSupersedeChain(factId: string | null) {
  return useQuery({
    queryKey: ['supersede-chain', factId],
    queryFn: ({ signal }) =>
      apiGet<SupersedeChainPayload>('/supersede-chains', {
        search: { factId },
        signal,
      }),
    enabled: factId !== null,
    staleTime: 60_000,
  });
}
