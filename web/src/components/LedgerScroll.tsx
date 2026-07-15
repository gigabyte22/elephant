import { type ReactNode, useEffect, useRef, useState } from 'react';

// Horizontal-scroll shell for the monospace ledgers (Facts, Dreams, Audit,
// Entities, the Overview preview). The grid templates inside stay fixed-rem —
// that baseline alignment IS the ledger look — so on narrow viewports the
// whole ledger pans sideways instead of crushing its columns. A right-edge
// fade hints at clipped columns until the user reaches the end.

interface Props {
  // Natural width of the ledger's grid template, e.g. '44rem'.
  minWidth: string;
  children: ReactNode;
}

export function LedgerScroll({ minWidth, children }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => {
      setClipped(el.scrollWidth - el.clientWidth - el.scrollLeft > 8);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    el.addEventListener('scroll', measure, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', measure);
    };
  }, []);

  return (
    <div className="relative">
      <div ref={scroller} className="overflow-x-auto" style={{ overscrollBehaviorX: 'contain' }}>
        <div style={{ minWidth }}>{children}</div>
      </div>
      {clipped && (
        <div
          className="pointer-events-none absolute inset-y-0 right-0 w-12"
          style={{
            background: 'linear-gradient(to left, rgba(6,5,12,0.9), transparent)',
          }}
          aria-hidden
        />
      )}
    </div>
  );
}
