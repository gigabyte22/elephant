import { describe, expect, test } from 'vitest';
import { createChunker } from '../../src/services/Chunker.ts';
import { approxTokens } from '../../src/utils/tokens.ts';

const countTokens = async (t: string) => approxTokens(t);

describe('Chunker', () => {
  test('empty input → no chunks', async () => {
    const c = createChunker({ countTokens });
    expect(await c.chunk('', { maxTokens: 100, overlapTokens: 0 })).toEqual([]);
    expect(await c.chunk('   \n  ', { maxTokens: 100, overlapTokens: 0 })).toEqual([]);
  });

  test('short input → single chunk at position 0', async () => {
    const c = createChunker({ countTokens });
    const out = await c.chunk('hello world', { maxTokens: 100, overlapTokens: 10 });
    expect(out).toHaveLength(1);
    expect(out[0]!.position).toBe(0);
    expect(out[0]!.text).toBe('hello world');
    expect(out[0]!.tokenCount).toBeGreaterThan(0);
  });

  test('splits long input; every chunk respects maxTokens', async () => {
    const c = createChunker({ countTokens });
    const paragraph = 'This is a sentence. '.repeat(50); // ~200 words
    const long = [paragraph, paragraph, paragraph].join('\n\n');
    const out = await c.chunk(long, { maxTokens: 80, overlapTokens: 0 });
    expect(out.length).toBeGreaterThan(1);
    for (const piece of out) {
      expect(piece.tokenCount).toBeLessThanOrEqual(80);
    }
    // positions monotonically increase
    const positions = out.map((p) => p.position);
    expect(positions).toEqual(positions.slice().sort((a, b) => a - b));
  });

  test('prefers paragraph boundaries over mid-paragraph splits', async () => {
    const c = createChunker({ countTokens });
    const p1 = 'Alpha. '.repeat(20); // ~140 chars ~ 35 tokens
    const p2 = 'Bravo. '.repeat(20);
    const p3 = 'Charlie. '.repeat(20);
    const out = await c.chunk(`${p1}\n\n${p2}\n\n${p3}`, { maxTokens: 50, overlapTokens: 0 });
    // Each chunk should start with one of Alpha/Bravo/Charlie (ignoring trailing whitespace from prior)
    for (const piece of out) {
      expect(piece.text.trimStart()).toMatch(/^(Alpha|Bravo|Charlie)/);
    }
  });

  test('never splits mid-word (greedy-pack by whitespace preserves words)', async () => {
    const c = createChunker({ countTokens });
    const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
    const out = await c.chunk(words, { maxTokens: 20, overlapTokens: 0 });
    for (const piece of out) {
      // No "wor" or "ord" fragments — every token starts with "word" prefix.
      const parts = piece.text.split(/\s+/);
      for (const p of parts) {
        expect(p).toMatch(/^word\d+$/);
      }
    }
  });

  test('overlap prepends content from the previous chunk', async () => {
    const c = createChunker({ countTokens });
    // Use numbered sentences so we can track which originated in which chunk.
    const sentences = Array.from({ length: 30 }, (_, i) => `Sentence ${i}.`).join(' ');
    const withOverlap = await c.chunk(sentences, { maxTokens: 30, overlapTokens: 10 });
    expect(withOverlap.length).toBeGreaterThan(1);
    // chunk[1] must contain some sentence number that also appears in chunk[0].
    const firstSentences = new Set(withOverlap[0]!.text.match(/Sentence \d+/g) ?? []);
    const secondSentences = withOverlap[1]!.text.match(/Sentence \d+/g) ?? [];
    const shared = secondSentences.filter((s) => firstSentences.has(s));
    expect(shared.length).toBeGreaterThan(0);
  });

  test('respects maxTokens ceiling even with overlap', async () => {
    const c = createChunker({ countTokens });
    const paragraph = 'One two three four five. '.repeat(30);
    const chunks = await c.chunk(paragraph, { maxTokens: 40, overlapTokens: 10 });
    for (const piece of chunks) {
      expect(piece.tokenCount).toBeLessThanOrEqual(40);
    }
  });
});
