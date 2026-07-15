import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client.ts';
import type { GraphNeighborhoodPayload } from '../api/types.ts';

interface Args {
  nodeId: string | null;
  depth: 1 | 2;
  maxNodes?: number;
}

export function useGraphNeighborhood({ nodeId, depth, maxNodes = 150 }: Args) {
  return useQuery({
    queryKey: ['graph-neighborhood', nodeId, depth, maxNodes],
    queryFn: ({ signal }) =>
      apiGet<GraphNeighborhoodPayload>('/graph/neighborhood', {
        search: { nodeId, depth, maxNodes },
        signal,
      }),
    enabled: nodeId !== null,
    staleTime: 30_000,
  });
}
