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

export interface ExtractionResult {
  status: ExtractionStatus;
  text: string;
  /** Optional human-readable note (e.g. provider name, error summary). */
  detail?: string;
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
