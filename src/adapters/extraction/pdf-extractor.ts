import { deferred } from './service.ts';
import type { ExtractionInput, ExtractionResult, Extractor } from './types.ts';

/** Reads text out of one rendered page image. */
export type OcrPage = (input: ExtractionInput) => Promise<ExtractionResult>;

export interface PdfConfig {
  /**
   * Supplied by the factory as the vision extractor when one is configured;
   * absent means a scanned PDF stays 'empty'.
   */
  ocrPage?: OcrPage;
  /** Longest edge, in px, pages are rendered at before OCR. */
  renderWidth: number;
  /** How many pages of a scanned PDF are worth a model call each. */
  maxOcrPages: number;
}

function supportsPdf(mime: string): boolean {
  return mime === 'application/pdf';
}

// PDF text extraction. The text layer (pdf-parse) is the fast path and covers
// every PDF that was generated rather than photographed; it runs inline in
// milliseconds. A scan has no text layer, which used to end the story: the
// attachment was recorded 'empty' and its content was never searchable even
// with a vision provider configured, because routing is by MIME type and this
// extractor claims application/pdf outright. Now those pages are rendered and
// OCR'd — on the background worker, since that is N model calls.
export function createPdfExtractor(config: PdfConfig): Extractor {
  return {
    supports: supportsPdf,
    async extract(input: ExtractionInput): Promise<ExtractionResult> {
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: new Uint8Array(input.data) });
      try {
        // pageJoiner: '' — the default appends "-- 1 of 12 --" to every page,
        // which meant a scan with no text layer came back as a string of page
        // markers and was recorded 'done'. Synthetic text is worse than none:
        // it hid every unreadable PDF and put markers in the embedding.
        const { text } = await parser.getText({ pageJoiner: '' });
        const trimmed = text.trim();
        if (trimmed.length > 0) return { status: 'done', text: trimmed };

        const { ocrPage } = config;
        if (!ocrPage) {
          return { status: 'empty', text: '', detail: 'no extractable text layer' };
        }
        if (!input.allowSlow) return deferred('page OCR (no text layer)');
        return await ocrPages(parser, input, config, ocrPage);
      } catch (err) {
        return {
          status: 'failed',
          text: '',
          detail: err instanceof Error ? err.message : String(err),
        };
      } finally {
        await parser.destroy();
      }
    },
  };
}

type Parser = InstanceType<Awaited<typeof import('pdf-parse')>['PDFParse']>;

// Render each page to a raster image and read it with the vision extractor.
// @napi-rs/canvas comes with pdf-parse, so this needs no new dependency.
async function ocrPages(
  parser: Parser,
  input: ExtractionInput,
  config: PdfConfig,
  ocrPage: OcrPage,
): Promise<ExtractionResult> {
  const shot = await parser.getScreenshot({
    imageBuffer: true,
    // A data URL of every page as well would double the memory for bytes we
    // immediately re-encode; the buffer is what the vision extractor wants.
    imageDataUrl: false,
    desiredWidth: config.renderWidth,
    first: config.maxOcrPages,
  });
  const rendered = shot.pages.filter((p) => p.data?.length);
  if (rendered.length === 0) {
    return { status: 'empty', text: '', detail: 'no text layer, and no page could be rendered' };
  }

  // Sequential on purpose: the vision model and the embedder share one GPU on a
  // local deployment, so N concurrent pages would queue at the provider while
  // starving ordinary ingestion.
  const pages: string[] = [];
  for (const page of rendered) {
    const result = await ocrPage({
      data: Buffer.from(page.data!),
      mimeType: 'image/png',
      filename: `${input.filename}#page-${page.pageNumber}`,
      allowSlow: true,
    });
    if (result.text.length === 0) continue;
    pages.push(`[page ${page.pageNumber}]\n${result.text}`);
  }

  if (pages.length === 0) {
    return { status: 'empty', text: '', detail: `OCR of ${rendered.length} page(s) found no text` };
  }
  // A page the model refused, or a document longer than the page budget, is a
  // partial reading — the same claim 'truncated' makes about a cut-off OCR.
  const unreadable = rendered.length - pages.length;
  const incomplete = unreadable > 0 || shot.total > rendered.length;
  const note = unreadable > 0 ? `, ${unreadable} unreadable` : '';
  return {
    status: incomplete ? 'truncated' : 'done',
    text: pages.join('\n\n'),
    derivation: 'model',
    detail: `OCR of ${pages.length}/${shot.total} page(s)${note}`,
  };
}
