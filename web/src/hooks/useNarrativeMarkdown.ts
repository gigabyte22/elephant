import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client.ts';
import type { NarrativeKind, NarrativeMarkdownPayload } from '../api/types.ts';

// Fetches the vault's markdown projection of a research / knowledge node.
// The graph payload truncates `content` to 200 chars, so the body has to be
// re-fetched by id rather than read off the selected node's props. Callers
// mount the panel on demand, which is what keeps full document bodies off the
// wire until someone actually asks for one.

interface Args {
  kind: NarrativeKind;
  id: string;
  projectId?: string;
}

export function useNarrativeMarkdown({ kind, id, projectId }: Args) {
  return useQuery({
    queryKey: ['narrative-markdown', kind, id, projectId],
    queryFn: ({ signal }) =>
      apiGet<NarrativeMarkdownPayload>(
        kind === 'research' ? `/research/${id}/markdown` : `/knowledge/documents/${id}/markdown`,
        // projectId only scopes research; the knowledge route ignores it.
        { search: kind === 'research' ? { projectId } : undefined, signal },
      ),
    staleTime: 30_000,
  });
}
