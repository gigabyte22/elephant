import { type ReactNode, useEffect } from 'react';
import { useIsDesktop } from '../hooks/useMediaQuery.ts';

// Shared drill-down surface. Desktop: a right-edge slide-over in the same
// projected-glass treatment as the cosmos panels. Mobile: a bottom sheet.
// Hosts fact details, dream-run breakdowns, and anything else that needs
// more room than a ledger row.

const glass = 'border border-hairline-strong bg-ink-900/90 backdrop-blur-md shadow-panel';

interface Props {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
}

export function DetailPanel({ open, onClose, title, children }: Props) {
  const desktop = useIsDesktop();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    // biome-ignore lint/a11y/useSemanticElements: styled overlay panel; native <dialog> fights the custom backdrop/animation
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true">
      <button
        type="button"
        className="absolute inset-0 h-full w-full cursor-default bg-ink-900/60"
        onClick={onClose}
        aria-label="close detail"
        tabIndex={-1}
      />
      <aside
        className={`projected absolute flex animate-fade-up flex-col ${glass} ${
          desktop
            ? 'inset-y-0 right-0 w-[26rem] border-y-0 border-r-0'
            : 'inset-x-0 bottom-0 max-h-[80vh] border-x-0 border-b-0'
        }`}
      >
        <header className="flex items-center justify-between gap-4 border-b border-hairline px-5 py-4">
          <div className="min-w-0 flex-1">{title}</div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 font-mono text-2xs uppercase tracking-widest text-ink-400 transition-colors hover:text-accent-300"
          >
            close ✕
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>
      </aside>
    </div>
  );
}
