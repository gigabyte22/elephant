import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { NarrativeKind } from '../api/types.ts';
import { useNarrativeMarkdown } from '../hooks/useNarrativeMarkdown.ts';
import { useScope } from '../hooks/useScope.ts';
import { DetailPanel } from './DetailPanel.tsx';
import { SegBtnGroup } from './SegButtons.tsx';

// "Open as markdown" for a research / knowledge node. Shows exactly what the
// OKF vault would write for this node — the endpoint reuses the vault's own
// serializer, so the source view is byte-identical to the .md on disk.
//
// Mounted only while open, so opening the panel is what triggers the fetch.

const VIEWS = ['rendered', 'source'] as const;
type View = (typeof VIEWS)[number];

type CopyState = 'idle' | 'copied' | 'failed';
const COPY_LABEL: Record<CopyState, string> = {
  idle: 'copy',
  copied: 'copied',
  failed: 'copy failed',
};

// Strip the YAML frontmatter for the rendered view. Handing it to
// react-markdown turns it into prose — the `---` fences read as rules and the
// keys collapse into one paragraph, with `tags:` becoming a bullet list. It is
// machine metadata; the source view shows it verbatim for anyone who wants it.
//
// Mirrors the split in parseVaultDoc without needing a YAML parser: the body
// is everything past the closing fence.
function stripFrontmatter(md: string): string {
  if (!md.startsWith('---\n')) return md;
  const end = md.indexOf('\n---\n', 4);
  if (end < 0) return md;
  return md.slice(end + 5).replace(/^\n+/, '');
}

interface Props {
  onClose: () => void;
  kind: NarrativeKind;
  id: string;
}

export function MarkdownPanel({ onClose, kind, id }: Props) {
  const [view, setView] = useState<View>('rendered');
  const [copyState, setCopyState] = useState<CopyState>('idle');
  // Cleared on unmount so closing the panel mid-flash doesn't set state on a
  // component that is gone.
  const resetTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(resetTimer.current), []);
  const scope = useScope();
  const { data, isLoading, error } = useNarrativeMarkdown({
    kind,
    id,
    projectId: scope.projectId,
  });

  // writeText rejects without transient user activation, in insecure contexts,
  // and when permission is denied. Unhandled, that leaves the button silently
  // doing nothing — so failure gets its own label rather than no feedback.
  const copy = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.markdown);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopyState('idle'), 1500);
  };

  const download = () => {
    if (!data) return;
    const url = URL.createObjectURL(new Blob([data.markdown], { type: 'text/markdown' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = data.filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <DetailPanel
      open
      onClose={onClose}
      title={
        <span className="block truncate font-mono text-2xs text-ink-300" title={data?.filename}>
          {data?.filename ?? 'markdown'}
        </span>
      }
    >
      <div className="flex items-center gap-3 pb-5">
        <SegBtnGroup value={view} options={VIEWS} onChange={setView} render={(v) => v} />
        <div className="ml-auto flex items-center gap-3">
          <PanelAction onClick={copy} disabled={!data} label={COPY_LABEL[copyState]} />
          <PanelAction onClick={download} disabled={!data} label="download" />
        </div>
      </div>

      {isLoading && <Note>loading…</Note>}
      {error && <Note>{error instanceof Error ? error.message : 'failed to load'}</Note>}

      {data &&
        (view === 'source' ? (
          <pre className="overflow-x-auto whitespace-pre-wrap break-words border-l-2 border-accent-500/40 bg-white/[0.01] p-4 font-mono text-2xs leading-relaxed text-ink-300">
            {data.markdown}
          </pre>
        ) : (
          <div className="markdown-body text-sm leading-relaxed text-ink-200">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {stripFrontmatter(data.markdown)}
            </ReactMarkdown>
          </div>
        ))}
    </DetailPanel>
  );
}

function PanelAction({
  onClick,
  disabled,
  label,
}: {
  onClick: () => void;
  disabled: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="font-mono text-2xs uppercase tracking-widest text-ink-400 transition-colors hover:text-accent-300 disabled:opacity-40 disabled:hover:text-ink-400"
    >
      {label}
    </button>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-mono text-2xs uppercase tracking-widest text-ink-500">{children}</div>
  );
}
