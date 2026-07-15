import type { ExtractionInput, ExtractionResult, ExtractionService, Extractor } from './types.ts';

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
