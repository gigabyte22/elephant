// Display helpers — keep formatting decisions out of components so the
// dashboard renders consistently. Tabular and terse by default.

const compactNumber = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

const fullNumber = new Intl.NumberFormat('en-US');

export function fmtCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (Math.abs(n) >= 10_000) return compactNumber.format(n);
  return fullNumber.format(n);
}

export function fmtPercent(n: number, total: number, digits = 1): string {
  if (total === 0) return '—';
  return `${((n / total) * 100).toFixed(digits)}%`;
}

export function fmtMs(ms: number | null): string {
  if (ms === null || Number.isNaN(ms)) return '—';
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(2)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

export function fmtRelativeTime(iso: string | null): string {
  if (!iso) return '—';
  const ts = new Date(iso).getTime();
  const now = Date.now();
  const delta = Math.round((now - ts) / 1000);
  if (delta < 5) return 'just now';
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.round(delta / 60)}m ago`;
  if (delta < 86_400) return `${Math.round(delta / 3600)}h ago`;
  return `${Math.round(delta / 86_400)}d ago`;
}

export function fmtKindLabel(kind: string): string {
  // 'knowledge_document' → 'KNOWLEDGE.DOCUMENT'
  return kind.replace(/_/g, '.').toUpperCase();
}

export function truncateText(s: string, n: number): string {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
