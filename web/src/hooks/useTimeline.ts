import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client.ts';
import type { MemoryKind, TimelineBucket, TimelinePayload } from '../api/types.ts';
import type { Scope } from '../lib/scope.ts';

interface Args {
  scope: Scope;
  kind?: MemoryKind;
  bucket?: TimelineBucket;
  days?: number;
}

export function useTimeline({ scope, kind = 'fact', bucket = 'day', days = 30 }: Args) {
  return useQuery({
    queryKey: ['timeline', kind, bucket, days, scope],
    queryFn: ({ signal }) =>
      apiGet<TimelinePayload>('/timeline', {
        search: { ...scope, kind, bucket, days },
        signal,
      }),
    staleTime: 60_000,
  });
}
