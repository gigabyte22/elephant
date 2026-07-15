// Display truncation used for dashboard previews. Adds a single-char ellipsis
// when the string exceeds `n` chars so the visible glyph count stays at `n`.

export function truncate(s: string | null | undefined, n: number): string {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
