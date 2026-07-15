import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client.ts';
import type { AuditEventKind, AuditPayload } from '../api/types.ts';

export type { AuditEvent, AuditEventKind, AuditPayload } from '../api/types.ts';

interface Args {
  actor?: string;
  kind?: AuditEventKind;
  to?: string;
  limit?: number;
  // Auto-refresh only makes sense for the live head of the feed, not for
  // "load older" pages anchored by a `to` cursor.
  refetch?: boolean;
}

export function useAudit({ actor, kind, to, limit = 100, refetch = true }: Args) {
  return useQuery({
    queryKey: ['audit', actor, kind, to, limit],
    queryFn: ({ signal }) =>
      apiGet<AuditPayload>('/audit', {
        search: { actor, kind, to, limit },
        signal,
      }),
    refetchInterval: refetch ? 30_000 : false,
    staleTime: 10_000,
  });
}
