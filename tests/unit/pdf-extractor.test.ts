import { describe, expect, it, vi } from 'vitest';
import { createPdfExtractor } from '../../src/adapters/extraction/pdf-extractor.ts';
import type { ExtractionInput, ExtractionResult } from '../../src/adapters/extraction/types.ts';

// A structurally valid PDF whose pages carry no content stream — the shape a
// scan has from pdf-parse's point of view: renderable, but with nothing in the
// text layer. Built here rather than committed as a binary so the fixture is
// reviewable.
function textlessPdf(pages: number): Buffer {
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(' ');
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    `<</Type/Pages/Kids[${kids}]/Count ${pages}>>`,
    ...Array.from({ length: pages }, () => '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>'),
  ];

  let body = '%PDF-1.4\n';
  const offsets = objects.map((obj, i) => {
    const offset = body.length;
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
    return offset;
  });
  const xrefStart = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

const input = (data: Buffer, allowSlow?: boolean): ExtractionInput => ({
  data,
  mimeType: 'application/pdf',
  filename: 'scan.pdf',
  allowSlow,
});

function fakeOcr(text: (page: number) => string | null) {
  return vi.fn(async (page: ExtractionInput): Promise<ExtractionResult> => {
    const n = Number(page.filename.split('#page-')[1] ?? 0);
    const out = text(n);
    return out === null
      ? { status: 'empty', text: '', detail: 'fake' }
      : { status: 'done', text: out, detail: 'fake', derivation: 'model' };
  });
}

describe('createPdfExtractor', () => {
  it('reports empty when there is no text layer and no OCR fallback', async () => {
    const pdf = createPdfExtractor({ renderWidth: 256, maxOcrPages: 5 });
    await expect(pdf.extract(input(textlessPdf(1), true))).resolves.toMatchObject({
      status: 'empty',
      detail: 'no extractable text layer',
    });
  });

  it('defers to the worker rather than OCRing inside the upload request', async () => {
    const ocrPage = fakeOcr(() => 'page text');
    const pdf = createPdfExtractor({ ocrPage, renderWidth: 256, maxOcrPages: 5 });

    // allowSlow omitted: this is the upload path, under a client timeout.
    const result = await pdf.extract(input(textlessPdf(1)));

    expect(result.status).toBe('pending');
    expect(ocrPage).not.toHaveBeenCalled();
  });

  it('OCRs the rendered pages when the slow path is allowed', async () => {
    const ocrPage = fakeOcr((n) => `text of page ${n}`);
    const pdf = createPdfExtractor({ ocrPage, renderWidth: 256, maxOcrPages: 5 });

    const result = await pdf.extract(input(textlessPdf(2), true));

    expect(ocrPage).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('done');
    // Model-derived, because it is: this is a reading of an image of a page.
    expect(result.derivation).toBe('model');
    expect(result.text).toContain('[page 1]\ntext of page 1');
    expect(result.text).toContain('[page 2]\ntext of page 2');
    expect(result.detail).toBe('OCR of 2/2 page(s)');
  });

  it('caps the page budget and calls the partial reading truncated', async () => {
    const ocrPage = fakeOcr((n) => `text of page ${n}`);
    const pdf = createPdfExtractor({ ocrPage, renderWidth: 256, maxOcrPages: 2 });

    const result = await pdf.extract(input(textlessPdf(5), true));

    // One model call per page, so an unbounded scan is an unbounded bill.
    expect(ocrPage).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('truncated');
    expect(result.detail).toBe('OCR of 2/5 page(s)');
  });

  it('keeps the pages it could read when one comes back blank', async () => {
    const ocrPage = fakeOcr((n) => (n === 1 ? null : `text of page ${n}`));
    const pdf = createPdfExtractor({ ocrPage, renderWidth: 256, maxOcrPages: 5 });

    const result = await pdf.extract(input(textlessPdf(2), true));

    expect(result.status).toBe('truncated');
    expect(result.text).toBe('[page 2]\ntext of page 2');
    expect(result.detail).toContain('1 unreadable');
  });

  it('maps a corrupt file to failed rather than throwing', async () => {
    const pdf = createPdfExtractor({ renderWidth: 256, maxOcrPages: 5 });
    await expect(pdf.extract(input(Buffer.from('this is not a pdf'), true))).resolves.toMatchObject(
      { status: 'failed' },
    );
  });
});
