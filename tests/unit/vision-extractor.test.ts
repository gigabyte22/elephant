import { describe, expect, it } from 'vitest';
import { mapVisionResponse } from '../../src/adapters/extraction/vision-extractor.ts';

const meta = { provider: 'anthropic', model: 'claude-sonnet-4-6' };

describe('mapVisionResponse', () => {
  it('reports a complete reading as done, carrying provider:model', () => {
    expect(mapVisionResponse({ text: '  INVOICE 4471  ', truncated: false }, meta)).toEqual({
      status: 'done',
      text: 'INVOICE 4471',
      detail: 'anthropic:claude-sonnet-4-6',
      // OCR and the description are both the model's rendering of the image,
      // not the image's own words, and the chunks say so.
      derivation: 'model',
    });
  });

  it('keeps text that hit the output ceiling but marks it truncated', () => {
    // The defect this exists for: a dense screenshot whose transcription stops
    // mid-word used to be stored as 'done', so a half-read attachment looked
    // exactly like a fully-read one.
    const result = mapVisionResponse({ text: 'line one\nline t', truncated: true }, meta);
    expect(result.status).toBe('truncated');
    expect(result.text).toBe('line one\nline t');
    expect(result.detail).toContain('max_tokens');
    expect(result.derivation).toBe('model');
  });

  it('reports empty output as empty, noting truncation when that is why', () => {
    expect(mapVisionResponse({ text: '   ', truncated: false }, meta)).toMatchObject({
      status: 'empty',
      text: '',
      detail: 'anthropic:claude-sonnet-4-6',
    });
    expect(mapVisionResponse({ text: '', truncated: true }, meta).detail).toContain('max_tokens');
  });
});
