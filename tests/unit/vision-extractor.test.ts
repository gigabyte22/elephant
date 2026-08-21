import { describe, expect, it, vi } from 'vitest';
import {
  checkVisionOutput,
  createVisionExtractor,
  DESCRIPTION_MARKER,
  mapVisionResponse,
  type VisionConfig,
  type VisionTargetConfig,
} from '../../src/adapters/extraction/vision-extractor.ts';

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

describe('checkVisionOutput', () => {
  it('passes a transcription followed by the description line', () => {
    expect(
      checkVisionOutput(
        'CLUB DISTANCES\n| Club | Carry |\n| 7 Iron | 146 yds |\nDESCRIPTION: a golf stats table',
      ),
    ).toBeNull();
  });

  it('passes the explicit no-text sentinel', () => {
    expect(checkVisionOutput('NO TEXT\nDESCRIPTION: a photo of a sunset')).toBeNull();
  });

  it('passes a legitimately tiny transcription', () => {
    // No minimum-length heuristic: a photo of a single word is two short lines.
    expect(checkVisionOutput('EXIT\nDESCRIPTION: a sign on a door')).toBeNull();
  });

  it('flunks an empty response', () => {
    expect(checkVisionOutput('   ')).toBe('empty response');
  });

  it('flunks output without the description marker', () => {
    // The observed failure: a model that gives up emits a few heading tokens
    // with a clean stop and never reaches the marker line.
    expect(checkVisionOutput('# Club Distances\n# Final Results')).toContain(DESCRIPTION_MARKER);
  });

  it('flunks a description with no transcription and no sentinel', () => {
    expect(checkVisionOutput('DESCRIPTION: a golf stats table')).toContain('no transcription');
  });
});

describe('createVisionExtractor', () => {
  // A real 1x1 PNG: prepareImageForVision decodes it, finds it within maxDim,
  // and passes the original bytes through untouched.
  const PNG_1X1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  const input = { data: PNG_1X1, mimeType: 'image/png', filename: 'shot.png', allowSlow: true };

  const local: VisionTargetConfig = {
    provider: 'openai',
    model: 'qwen2.5vl:7b',
    openaiBaseUrl: 'http://ollama:11434/v1',
  };
  const remote: VisionTargetConfig = {
    provider: 'openai',
    model: 'grok-4-1-fast-non-reasoning',
    openaiBaseUrl: 'https://api.x.ai/v1',
    openaiApiKey: 'xai-test',
  };
  const config = (targets: VisionTargetConfig[]): VisionConfig => ({
    targets,
    timeoutMs: 1_000,
    maxDim: 1024,
    jpegQuality: 80,
    maxTokens: 4096,
  });

  const CONFORMING = 'CLUB DISTANCES\n| 7 Iron | 146 yds |\nDESCRIPTION: a golf stats table';
  const JUNK = '# Club Distances\n# Final Results';

  it('returns done with the legacy provider:model detail when the only target conforms', async () => {
    const call = vi.fn().mockResolvedValue({ text: CONFORMING, truncated: false });
    const result = await createVisionExtractor(config([local]), call).extract(input);
    expect(result).toMatchObject({
      status: 'done',
      text: CONFORMING,
      detail: 'openai:qwen2.5vl:7b',
      derivation: 'model',
    });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('advances to the fallback when the primary flunks the quality guard', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ text: JUNK, truncated: false })
      .mockResolvedValueOnce({ text: CONFORMING, truncated: false });
    const result = await createVisionExtractor(config([local, remote]), call).extract(input);
    expect(result.status).toBe('done');
    expect(result.text).toBe(CONFORMING);
    expect(result.detail).toMatch(
      /^openai:grok-4-1-fast-non-reasoning \(fallback after openai:qwen2\.5vl:7b flunked quality guard: missing DESCRIPTION: marker\)$/,
    );
  });

  it('advances to the fallback when the primary call throws', async () => {
    // Ollama being down and ollama producing junk are the same event to the
    // attachment: the fallback is the next best reading either way.
    const call = vi
      .fn()
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
      .mockResolvedValueOnce({ text: CONFORMING, truncated: false });
    const result = await createVisionExtractor(config([local, remote]), call).extract(input);
    expect(result.status).toBe('done');
    expect(result.detail).toContain('fallback after openai:qwen2.5vl:7b: connect ECONNREFUSED');
  });

  it('records failed naming every outcome when all targets flunk', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ text: JUNK, truncated: false })
      .mockRejectedValueOnce(new Error('402 payment required'));
    const result = await createVisionExtractor(config([local, remote]), call).extract(input);
    expect(result.status).toBe('failed');
    expect(result.text).toBe('');
    expect(result.detail).toContain('all vision targets failed');
    expect(result.detail).toContain('openai:qwen2.5vl:7b flunked quality guard');
    expect(result.detail).toContain('openai:grok-4-1-fast-non-reasoning: 402 payment required');
  });

  it('accepts a truncated-but-nonempty primary reading without trying the fallback', async () => {
    // The fallback shares maxTokens and would truncate the same way; the guard
    // is skipped because output clipped mid-stream can never carry the marker.
    const call = vi.fn().mockResolvedValue({ text: 'CLUB DIST', truncated: true });
    const result = await createVisionExtractor(config([local, remote]), call).extract(input);
    expect(result.status).toBe('truncated');
    expect(result.detail).toBe(
      'openai:qwen2.5vl:7b — output stopped at max_tokens; transcription is incomplete',
    );
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('treats a truncated-and-empty primary as a flunk and advances', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ text: '', truncated: true })
      .mockResolvedValueOnce({ text: CONFORMING, truncated: false });
    const result = await createVisionExtractor(config([local, remote]), call).extract(input);
    expect(result.status).toBe('done');
    expect(result.detail).toContain('produced no text before hitting max_tokens');
  });

  it('still defers to the background worker before any provider call', async () => {
    const call = vi.fn();
    const result = await createVisionExtractor(config([local, remote]), call).extract({
      ...input,
      allowSlow: false,
    });
    expect(result.status).toBe('pending');
    expect(call).not.toHaveBeenCalled();
  });
});
