// Pluggable text extraction from attachment bytes. Each attachment is routed
// by MIME type to an extractor; the resulting text is chunked + embedded as
// :KnowledgeChunk nodes so attachment content is retrievable via /recall.

export type ExtractionStatus =
  | 'done' // text extracted and indexed
  | 'pending' // queued for the async extraction worker; not yet attempted
  | 'empty' // extractor ran but found no text
  | 'truncated' // text extracted and indexed, but known to be incomplete
  | 'unsupported' // no extractor handles this MIME type
  | 'skipped' // extractor exists but declined: no provider configured, or input it cannot read
  | 'failed'; // extractor threw

/**
 * Where the extracted text came from.
 *
 * 'verbatim' — bytes that were already text (a .txt file, a PDF's text layer).
 * 'model'    — a model's rendering of non-text bytes: OCR, a transcription, a
 *              description of a photo. It may be wrong in ways verbatim text
 *              cannot be, and it is the model's words, not the source's.
 *
 * The distinction survives into the chunk so recall can tell a consumer which
 * it is holding. Without it, "a screenshot of a dashboard showing revenue down
 * 12%" reads exactly like a sentence someone wrote.
 */
export type ExtractionDerivation = 'verbatim' | 'model';

export interface ExtractionResult {
  status: ExtractionStatus;
  text: string;
  /** Optional human-readable note (e.g. provider name, error summary). */
  detail?: string;
  /** Defaults to 'verbatim' when absent — the empty-text results (unsupported,
   *  failed, skipped) have no derivation to speak of. */
  derivation?: ExtractionDerivation;
}

export interface ExtractionInput {
  data: Buffer;
  mimeType: string;
  filename: string;
}

export interface Extractor {
  /** Whether this extractor handles the given MIME type. */
  supports(mimeType: string): boolean;
  extract(input: ExtractionInput): Promise<ExtractionResult>;
}

export interface ExtractionService {
  /** Route to the matching extractor; never throws — failures map to a status. */
  extract(input: ExtractionInput): Promise<ExtractionResult>;
}
