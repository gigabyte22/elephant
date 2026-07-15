// Placeholder rendered for pages not yet built (Graph, Facts, Timeline,
// Dreams, Audit). Single hairline-bordered "blueprint" panel matching the
// shell aesthetic so the empty state doesn't feel cheap.

interface Props {
  label: string;
  rank: number;
  description: string;
}

export function Placeholder({ label, rank, description }: Props) {
  return (
    <div className="mx-auto max-w-3xl pt-20">
      <div className="flex items-baseline gap-5 pb-7">
        <span className="font-mono text-2xs tabular-nums tracking-widest text-accent-500">
          {String(rank).padStart(2, '0')}
        </span>
        <h1 className="font-mono text-display-sm font-light tracking-tight text-ink-100">
          {label}
        </h1>
      </div>
      <div className="border-y border-dashed border-hairline-strong py-12 text-center">
        <span className="label-meta block pb-4">module not yet wired</span>
        <p className="mx-auto max-w-md text-sm leading-relaxed text-ink-300">{description}</p>
      </div>
    </div>
  );
}
