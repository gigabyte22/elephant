import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client.ts';
import type { EntityTypesPayload } from '../api/types.ts';

// Entities carry no scope axes — this distribution is global by design.
export function useEntityTypes() {
  return useQuery({
    queryKey: ['entity-types'],
    queryFn: ({ signal }) => apiGet<EntityTypesPayload>('/entities/types', { signal }),
    staleTime: 30_000,
  });
}
