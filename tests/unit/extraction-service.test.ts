import { describe, expect, it } from 'vitest';
import {
  createDisabledExtractor,
  createExtractionService,
} from '../../src/adapters/extraction/service.ts';
import type { ExtractionResult, Extractor } from '../../src/adapters/extraction/types.ts';

function stub(
  supports: (mime: string) => boolean,
  result: ExtractionResult | (() => never),
): Extractor {
  return {
    supports,
    extract: async () => (typeof result === 'function' ? result() : result),
  };
}

const DONE: ExtractionResult = { status: 'done', text: 'hello', detail: 'stub' };
const input = (mimeType: string) => ({
  data: Buffer.from('x'),
  mimeType,
  filename: 'f',
});

describe('createExtractionService', () => {
  it('routes to the first extractor whose supports() matches', async () => {
    const svc = createExtractionService([
      stub((m) => m.startsWith('text/'), { status: 'done', text: 'first', detail: 'a' }),
      stub((m) => m === 'text/plain', { status: 'done', text: 'second', detail: 'b' }),
    ]);

    await expect(svc.extract(input('text/plain'))).resolves.toMatchObject({ text: 'first' });
  });

  it('reports unsupported when no extractor claims the MIME type', async () => {
    const svc = createExtractionService([stub((m) => m.startsWith('text/'), DONE)]);

    await expect(svc.extract(input('application/zip'))).resolves.toEqual({
      status: 'unsupported',
      text: '',
      detail: 'application/zip',
    });
  });

  it('maps a throwing extractor to failed rather than propagating', async () => {
    const svc = createExtractionService([
      stub(
        () => true,
        () => {
          throw new Error('provider exploded');
        },
      ),
    ]);

    await expect(svc.extract(input('image/jpeg'))).resolves.toEqual({
      status: 'failed',
      text: '',
      detail: 'provider exploded',
    });
  });

  it('reports skipped — not unsupported — when a media type is known but has no provider', async () => {
    // The distinction that matters: 'unsupported' means "elephant has no
    // extractor for this format", 'skipped' means "it does, but it is switched
    // off". Conflating them is what made unread images look like a file-type
    // problem instead of a configuration one.
    const svc = createExtractionService([
      createDisabledExtractor((m) => m.startsWith('image/'), 'no vision provider configured'),
    ]);

    await expect(svc.extract(input('image/jpeg'))).resolves.toEqual({
      status: 'skipped',
      text: '',
      detail: 'no vision provider configured',
    });
    await expect(svc.extract(input('application/zip'))).resolves.toMatchObject({
      status: 'unsupported',
    });
  });
});
