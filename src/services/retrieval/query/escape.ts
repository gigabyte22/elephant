// Lucene special-character escaping for the `fact_fulltext` and `chunk_fulltext`
// indexes. Without this, user queries containing `:`, `/`, `+`, `-`, `(`, `)`,
// `"`, or any boolean operator either error (500) or silently misbehave.
//
// Reserved set (Lucene 9 classic query parser):
//   + - && || ! ( ) { } [ ] ^ " ~ * ? : \ /
// We escape each reserved char with a leading backslash.

// Single-pass regex covering boolean operators and individual reserved chars.
// A two-pass approach would double-escape because the backslash injected for
// `&&` / `||` is itself a reserved char.
const LUCENE_SPECIAL = /(&&|\|\||[+\-!(){}[\]^"~*?:\\/])/g;

export function escapeLucene(q: string): string {
  if (!q) return '';
  return q.replace(LUCENE_SPECIAL, '\\$1').replace(/\s+/g, ' ').trim();
}

// Future hook for query rewriting (synonyms, entity disambiguation, per-query
// boosts). Today just returns the escaped string so the pipeline is stable.
export function expandQueryForFullText(q: string): string {
  return escapeLucene(q);
}
