import type { ExtractionInput, ExtractionResult, Extractor } from './types.ts';

// Plain-text family: text/*, JSON, CSV, markdown, and basic HTML (tags
// stripped). Always available — no external provider needed.
const TEXT_MIME = /^text\//;
const TEXT_LIKE = new Set([
  'application/json',
  'application/xml',
  'application/csv',
  'application/x-ndjson',
  'application/yaml',
  'application/x-yaml',
]);

function isHtml(mime: string): boolean {
  return mime === 'text/html' || mime === 'application/xhtml+xml';
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function createTextExtractor(): Extractor {
  return {
    supports(mime: string): boolean {
      return TEXT_MIME.test(mime) || TEXT_LIKE.has(mime) || isHtml(mime);
    },
    async extract(input: ExtractionInput): Promise<ExtractionResult> {
      const raw = input.data.toString('utf8');
      const text = isHtml(input.mimeType) ? stripHtml(raw) : raw.trim();
      return text.length > 0 ? { status: 'done', text } : { status: 'empty', text: '' };
    },
  };
}
