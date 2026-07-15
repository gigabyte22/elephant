// Token-aware recursive splitter. Prefers paragraph → sentence → word
// boundaries and never splits mid-word. Overlap carries the last
// `overlapTokens` of each chunk into the next, so a fact straddling a boundary
// is still embedded in context.

export interface ChunkPiece {
  text: string;
  tokenCount: number;
  position: number;
}

export interface ChunkerOptions {
  maxTokens: number;
  overlapTokens: number;
}

export interface Chunker {
  chunk(text: string, opts: ChunkerOptions): Promise<ChunkPiece[]>;
}

type CountTokens = (text: string) => Promise<number>;

const PARAGRAPH_SEP = /\n\s*\n/g;
const SENTENCE_SPLIT = /(?<=[.!?])\s+(?=[A-Z"'(\[])/g;
const WORD_SPLIT = /\s+/g;

// Splits a string on `separator`, keeping the separator by recombining with
// the original whitespace. Falls back to character-level splitting only when a
// single "word" itself exceeds the limit (rare; pathologically long URL etc).
function splitBy(text: string, separator: RegExp): string[] {
  const parts = text.split(separator);
  return parts.filter((p) => p.length > 0);
}

interface RecursiveCtx {
  countTokens: CountTokens;
  maxTokens: number;
}

// Returns an array of sub-strings each known to be <= maxTokens.
async function recursiveSplit(text: string, ctx: RecursiveCtx): Promise<string[]> {
  const tokens = await ctx.countTokens(text);
  if (tokens <= ctx.maxTokens) return [text];

  // Try progressively finer separators. Recurse on parts that are still too
  // big; parts that fit are kept intact so we don't over-fragment.
  for (const sep of [PARAGRAPH_SEP, SENTENCE_SPLIT, WORD_SPLIT]) {
    const parts = splitBy(text, sep);
    if (parts.length <= 1) continue;
    const out: string[] = [];
    for (const p of parts) out.push(...(await recursiveSplit(p, ctx)));
    return out;
  }

  // Last resort: we hit a single "word" longer than maxTokens. Hard-cut by
  // characters, approximating 4 chars/token. Better than looping forever.
  const charBudget = Math.max(1, ctx.maxTokens * 4);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += charBudget) {
    out.push(text.slice(i, i + charBudget));
  }
  return out;
}

export function createChunker(deps: { countTokens: CountTokens }): Chunker {
  async function chunk(text: string, opts: ChunkerOptions): Promise<ChunkPiece[]> {
    const trimmed = text.trim();
    if (!trimmed) return [];

    // Reserve room for the overlap prefix so the final chunk (after overlap
    // is prepended) still fits under maxTokens. The first chunk pays no
    // overlap cost but we leave the pack budget uniform for simplicity.
    const packBudget = Math.max(1, opts.maxTokens - opts.overlapTokens);

    const pieces = await recursiveSplit(trimmed, {
      countTokens: deps.countTokens,
      maxTokens: packBudget,
    });

    // Greedy pack: merge adjacent sub-pieces as long as the combined size
    // stays under packBudget. Keeps chunks close to — but not over — the
    // target and avoids shipping tiny fragments.
    const packed: string[] = [];
    let buf = '';
    for (const p of pieces) {
      if (buf === '') {
        buf = p;
        continue;
      }
      const combinedTokens = await deps.countTokens(`${buf}\n\n${p}`);
      if (combinedTokens <= packBudget) {
        buf = `${buf}\n\n${p}`;
      } else {
        packed.push(buf);
        buf = p;
      }
    }
    if (buf !== '') packed.push(buf);

    if (opts.overlapTokens <= 0) {
      return withPositions(packed, deps.countTokens);
    }

    // Add overlap: prepend the tail of chunk N-1 to chunk N. Because we
    // packed to (maxTokens - overlapTokens), the final chunk fits under
    // maxTokens.
    const overlapped: string[] = [];
    for (let i = 0; i < packed.length; i++) {
      if (i === 0) {
        overlapped.push(packed[i]!);
        continue;
      }
      const prev = packed[i - 1]!;
      const overlap = await takeTail(prev, opts.overlapTokens, deps.countTokens);
      overlapped.push(overlap ? `${overlap}\n\n${packed[i]!}` : packed[i]!);
    }

    return withPositions(overlapped, deps.countTokens);
  }

  return { chunk };
}

async function withPositions(texts: string[], count: CountTokens): Promise<ChunkPiece[]> {
  const out: ChunkPiece[] = [];
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i]!;
    out.push({ text: t, tokenCount: await count(t), position: i });
  }
  return out;
}

// Returns the suffix of `text` that is approximately `targetTokens` tokens long,
// broken on the nearest sentence boundary (falling back to whitespace).
async function takeTail(text: string, targetTokens: number, count: CountTokens): Promise<string> {
  if (targetTokens <= 0) return '';
  const total = await count(text);
  if (total <= targetTokens) return text;
  // Char-based slice; then realign forward to a clean boundary (sentence, then
  // whitespace) so we don't emit a fragment starting mid-word.
  const charTarget = Math.max(1, Math.ceil((targetTokens / total) * text.length));
  const slice = text.slice(Math.max(0, text.length - charTarget));
  for (const re of [/(?<=[.!?])\s+/, /\s/]) {
    const idx = slice.search(re);
    if (idx !== -1 && idx < slice.length - 1) return slice.slice(idx).trimStart();
  }
  return slice;
}
