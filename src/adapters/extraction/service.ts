import type { ExtractionInput, ExtractionResult, ExtractionService, Extractor } from './types.ts';

// A placeholder for a media type we know how to handle but have no provider for.
// Registering one keeps 'unsupported' honest — it now means "no extractor exists
// for this MIME" rather than doubling as "OCR is switched off", which is the
// ambiguity that let unread image attachments look like an unremarkable format
// problem. Callers get 'skipped' plus a reason instead.
export function createDisabledExtractor(
  supports: (mime: string) => boolean,
  detail: string,
): Extractor {
  return {
    supports,
    extract: async (): Promise<ExtractionResult> => ({ status: 'skipped', text: '', detail }),
  };
}

// Routes an attachment to the first extractor that supports its MIME type.
// Never throws — unsupported types and extractor errors map to a status so the
// upload pipeline can record it and still keep the stored blob.
export function createExtractionService(extractors: Extractor[]): ExtractionService {
  return {
    async extract(input: ExtractionInput): Promise<ExtractionResult> {
      const extractor = extractors.find((e) => e.supports(input.mimeType));
      if (!extractor) {
        return { status: 'unsupported', text: '', detail: input.mimeType };
      }
      try {
        return await extractor.extract(input);
      } catch (err) {
        return {
          status: 'failed',
          text: '',
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
