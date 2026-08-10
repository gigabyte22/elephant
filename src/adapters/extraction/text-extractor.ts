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

export interface TextConfig {
  /** Bytes of a single attachment that will be decoded and indexed. Text is
   *  the one family extracted inline, so an unbounded file would chunk and
   *  embed thousands of pieces inside the upload request. */
  maxBytes: number;
}

function isHtml(mime: string): boolean {
  return mime === 'text/html' || mime === 'application/xhtml+xml';
}

function supportsText(mime: string): boolean {
  return TEXT_MIME.test(mime) || TEXT_LIKE.has(mime) || isHtml(mime);
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

// Decode the entity forms that survive tag-stripping. Numeric entities are the
// ones a real page leans on most (&#8217; for a curly apostrophe), and leaving
// them raw put literal "&#8217;" into the search index, where it matches
// nothing a user would type.
function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    const named = NAMED_ENTITIES[body.toLowerCase()];
    if (named !== undefined) return named;
    if (body[0] !== '#') return match;
    const hex = body[1] === 'x' || body[1] === 'X';
    const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
    // Reject non-characters rather than emitting U+FFFD, which the binary
    // detector below would then read as corruption.
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
    return String.fromCodePoint(code);
  });
}

function stripHtml(html: string): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(stripped).replace(/\s+/g, ' ').trim();
}

// Let the byte-order mark pick the encoding. Without this a UTF-16 file decoded
// as UTF-8 stores one NUL between every character — searchable by nothing, and
// indistinguishable from a corrupt upload once it is in the graph.
function decode(data: Buffer): string {
  if (data[0] === 0xff && data[1] === 0xfe) return data.subarray(2).toString('utf16le');
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    return data.subarray(3).toString('utf8');
  }
  // UTF-16BE has no Node decoder. Byte-swapping to LE is exact for even-length
  // input, which a well-formed UTF-16 file always is.
  if (data[0] === 0xfe && data[1] === 0xff && data.length % 2 === 0) {
    return Buffer.from(data.subarray(2)).swap16().toString('utf16le');
  }
  return data.toString('utf8');
}

// Bytes that decoded to something no reader wants indexed. A NUL, or a decode
// error in the first stretch, means this is not the text the MIME type claims —
// far more often a mislabelled binary than a genuinely odd document.
const BINARY_SAMPLE_CHARS = 4096;
const NUL = '\u0000';
const REPLACEMENT_CHAR = '\uFFFD';
const REPLACEMENT_RATIO = 0.05;

function looksBinary(text: string): boolean {
  const sample = text.slice(0, BINARY_SAMPLE_CHARS);
  if (sample.length === 0) return false;
  if (sample.includes(NUL)) return true;
  let replacements = 0;
  for (const ch of sample) if (ch === REPLACEMENT_CHAR) replacements += 1;
  return replacements / sample.length > REPLACEMENT_RATIO;
}

// Cut at a whole code point: slicing a Buffer mid-sequence would hand the
// decoder a partial character, which becomes the U+FFFD that looksBinary reads
// as corruption.
function sliceUtf8(data: Buffer, maxBytes: number): Buffer {
  let end = maxBytes;
  while (end > 0 && (data[end]! & 0xc0) === 0x80) end -= 1;
  return data.subarray(0, end);
}

export function createTextExtractor(config: TextConfig): Extractor {
  return {
    supports: supportsText,
    async extract(input: ExtractionInput): Promise<ExtractionResult> {
      const oversized = input.data.byteLength > config.maxBytes;
      const bytes = oversized ? sliceUtf8(input.data, config.maxBytes) : input.data;

      const decoded = decode(bytes);
      if (looksBinary(decoded)) {
        return { status: 'skipped', text: '', detail: `binary content labelled ${input.mimeType}` };
      }

      const text = isHtml(input.mimeType) ? stripHtml(decoded) : decoded.trim();
      if (text.length === 0) return { status: 'empty', text: '' };
      if (oversized) {
        return {
          status: 'truncated',
          text,
          detail: `read the first ${config.maxBytes} of ${input.data.byteLength} bytes`,
        };
      }
      return { status: 'done', text };
    },
  };
}
