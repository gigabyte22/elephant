import type {
  Episode,
  ExtractedFact,
  ExtractedRelation,
  Fact,
  SupersedeDecision,
} from '../../models/types.ts';

export interface LLMAdapter {
  name: string;

  // Conservative total-context size (input + output). Used by the dreaming
  // service to decide how many chunks can be packed into a single extraction
  // call before risking truncation.
  maxContextTokens: number;

  // Estimated token count for `text`. Adapters may override with an accurate
  // tokenizer; default is the shared char-ratio heuristic.
  countTokens(text: string): Promise<number>;

  // Extract zero or more candidate facts from a conversation episode.
  // `existingFacts` is a small sample of related (vector-similar) active facts
  // so the model can avoid trivial restatements.
  extractFacts(input: {
    episode: Episode;
    existingFacts?: Pick<Fact, 'id' | 'content'>[];
  }): Promise<ExtractedFact[]>;

  // Decide whether `candidate` supersedes any of `existing`. Return null if no
  // supersede; otherwise the decision payload (without ids resolved — caller
  // attaches newFactId).
  detectSupersede(input: {
    candidate: Pick<Fact, 'id' | 'content'>;
    existing: Pick<Fact, 'id' | 'content'>[];
  }): Promise<Omit<SupersedeDecision, 'newFactId'> | null>;

  // Single-call summarization. Used by ingestion when a rawTranscript is long
  // enough that character-truncating the first ~500 chars would lose the plot.
  // Returned string MUST be short enough to embed in a single call — adapters
  // should constrain max_tokens accordingly.
  summarize(input: { text: string; targetTokens?: number }): Promise<string>;

  // Optional OpenIE-style relation extraction. Called by the dreaming service
  // (when DREAM_ENABLE_RELATION_EXTRACTION=true) with the entities already
  // pulled from an episode; returns directed triples among those entities only.
  // Adapters that don't implement this leave the entity graph relation-free.
  extractRelations?(input: {
    text: string;
    entities: Array<{ name: string; type: string }>;
  }): Promise<ExtractedRelation[]>;

  // Optional consolidation judge. Called by the dreaming service (when
  // DREAM_ENABLE_CONSOLIDATION=true) with a small cluster of live facts about
  // one entity; decides whether a subset states the same underlying knowledge
  // in fragments and, if so, returns one canonical merged fact. Adapters that
  // don't implement this skip the consolidation pass entirely.
  consolidateFacts?(input: {
    cluster: Array<{
      id: string;
      content: string;
      category?: string;
      confidence: number;
      importance: number;
    }>;
  }): Promise<{
    decision: 'merge' | 'keep';
    mergeFactIds: string[];
    content: string;
    category?: string;
    confidence: number;
    importance: number;
  } | null>;

  // Optional override; default importance scoring lives in src/utils/scoring.ts.
  scoreImportance?(fact: Pick<Fact, 'content' | 'category'>): Promise<number>;

  // Optional listwise reranker. Called by the retrieval pipeline when
  // `RETRIEVAL_ENABLE_RERANK=true` and the per-query `rerank=1` is set.
  // Returns a new ordering of the supplied candidates with a 0..1 score.
  // Adapters that don't implement this will no-op through the pipeline.
  rerank?(input: {
    query: string;
    candidates: Array<{ id: string; content: string }>;
    keepTopK: number;
  }): Promise<Array<{ id: string; score: number; reason?: string }>>;

  // Advertised cap on candidates per rerank call. The pipeline's own topK
  // already bounds this, but an adapter with a hard model limit can surface
  // it here so callers can shape their batches accordingly.
  maxRerankCandidates?: number;
}
