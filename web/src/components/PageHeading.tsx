import type { ReactNode } from 'react';

// Standard top-of-page banner: zero-padded rank tab on the left, display-font
// title (with chroma split) in the center, optional right slot for controls
// or status readouts. Used by every routed page except GraphExplorer, whose
// edge-to-edge canvas requires a slightly different padding shape.

interface Props {
  rank: number;
  title: string;
  right?: ReactNode;
  // Bottom margin; Overview wants a touch more breathing room above the
  // primary stat than the table-heavy pages do.
  bottomGap?: 'sm' | 'md';
}

export function PageHeading({ rank, title, right, bottomGap = 'sm' }: Props) {
  const mb = bottomGap === 'md' ? 'mb-8 md:mb-10' : 'mb-6 md:mb-8';
  return (
    <header
      className={`flex flex-col gap-4 border-b border-hairline pb-6 md:flex-row md:items-baseline md:justify-between md:pb-7 ${mb}`}
    >
      <div className="flex items-baseline gap-4 md:gap-5">
        <span className="font-mono text-2xs tabular-nums tracking-widest text-accent-500">
          {String(rank).padStart(2, '0')}
        </span>
        <h1 className="font-cinema text-display-sm font-light uppercase tracking-wide text-ink-100 chroma md:text-display">
          {title}
        </h1>
      </div>
      {right}
    </header>
  );
}
