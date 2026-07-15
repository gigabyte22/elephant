// Lightweight inline state surfaces — used while data is loading or errored.
// Both render as a single hairline-bordered row so layout never shifts.

export function LoadingBanner({ label = 'loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 border-y border-hairline py-3">
      <span className="h-1 w-1 animate-scan rounded-full bg-accent-500" aria-hidden />
      <span className="label-meta">{label}</span>
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="flex items-baseline justify-between border-y border-rust/40 py-3">
      <span className="font-mono text-2xs uppercase tracking-widest text-rust">error</span>
      <span className="font-mono text-2xs text-ink-300">{message}</span>
    </div>
  );
}
