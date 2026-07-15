import type { ExtractionInput, ExtractionResult, Extractor } from './types.ts';

// PDF text-layer extraction via pdf-parse (lazy-imported so the dependency is
// only loaded when a PDF is actually uploaded). Scanned/image-only PDFs yield
// little or no text → 'empty'.
export function createPdfExtractor(): Extractor {
  return {
    supports(mime: string): boolean {
      return mime === 'application/pdf';
    },
    async extract(input: ExtractionInput): Promise<ExtractionResult> {
      try {
        const { PDFParse } = await import('pdf-parse');
        const parser = new PDFParse({ data: new Uint8Array(input.data) });
        const { text } = await parser.getText();
        await parser.destroy();
        const trimmed = text.trim();
        return trimmed.length > 0
          ? { status: 'done', text: trimmed }
          : { status: 'empty', text: '', detail: 'no extractable text layer' };
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
