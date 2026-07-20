import 'dotenv/config';
import { z } from 'zod';

const LlmProvider = z.enum(['anthropic', 'openai', 'llamacpp']);
const EmbedProvider = z.enum(['openai', 'voyage', 'ollama']);

// Parse a boolean env var from its string form. z.coerce.boolean() uses JS
// Boolean() semantics, so the string "false" coerces to TRUE — a silent footgun
// that makes opt-out flags (e.g. FOO=false) impossible to disable. This treats
// the usual truthy spellings as true and everything else (including "false",
// "0", "no", "") as false.
const boolEnv = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .default(defaultValue)
    .transform((v) => {
      if (typeof v === 'boolean') return v;
      const s = v.trim().toLowerCase();
      return s === 'true' || s === '1' || s === 'yes' || s === 'on';
    });

const EnvSchema = z
  .object({
    MEMORY_PORT: z.coerce.number().int().positive().default(18790),
    MEMORY_BIND: z.string().default('127.0.0.1'),
    MEMORY_SERVICE_TOKEN: z.string().min(8, 'MEMORY_SERVICE_TOKEN must be at least 8 chars'),

    NEO4J_URI: z.string().default('bolt://localhost:7687'),
    NEO4J_USER: z.string().default('neo4j'),
    NEO4J_PASSWORD: z.string().min(1),
    NEO4J_DATABASE: z.string().default('neo4j'),

    MEMORY_LLM_PROVIDER: LlmProvider.default('anthropic'),
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_EXTRACTION_MODEL: z.string().default('claude-sonnet-4-6'),
    ANTHROPIC_DREAMING_MODEL: z.string().default('claude-opus-4-7'),

    OPENAI_API_KEY: z.string().optional(),
    OPENAI_BASE_URL: z
      .string()
      .url()
      .optional()
      .or(z.literal('').transform(() => undefined)),
    OPENAI_EXTRACTION_MODEL: z.string().default('gpt-4.1-mini'),

    MEMORY_EMBED_PROVIDER: EmbedProvider.default('openai'),
    OPENAI_EMBED_MODEL: z.string().default('text-embedding-3-large'),
    EMBED_DIM: z.coerce.number().int().positive().default(1536),

    LLAMACPP_BASE_URL: z
      .string()
      .url()
      .optional()
      .or(z.literal('').transform(() => undefined)),
    LLAMACPP_MODEL: z.string().default('qwen3.5:9b-turboquant'),
    OLLAMA_BASE_URL: z
      .string()
      .url()
      .optional()
      .or(z.literal('').transform(() => undefined)),
    OLLAMA_EMBED_MODEL: z.string().default('nomic-embed-text'),

    MEMORY_DREAM_CRON: z.string().default('0 3 * * *'),
    // OKF vault sweep. Staggered off MEMORY_DREAM_CRON because the dream cycle
    // can run for DREAM_DEADLINE_MS against the same driver pool. Only starts
    // when OKF_ENABLED (see scripts/serve.ts).
    OKF_SYNC_CRON: z.string().default('30 3 * * *'),
    MEMORY_OBSERVATION_TTL_DAYS: z.coerce.number().int().positive().default(7),

    // Working-state backend selection. Default Neo4j keeps everything in one
    // graph; Redis is opt-in for hot-path orchestration state.
    WORKING_STATE_BACKEND: z.enum(['neo4j', 'redis']).default('neo4j'),
    REDIS_URL: z
      .string()
      .url()
      .optional()
      .or(z.literal('').transform(() => undefined)),

    // Chunking / size limits. See SPEC.md §"Size limits and chunking".
    CHUNK_TARGET_TOKENS: z.coerce.number().int().positive().default(480),
    CHUNK_OVERLAP_TOKENS: z.coerce.number().int().nonnegative().default(50),
    SUMMARY_THRESHOLD_TOKENS: z.coerce.number().int().positive().default(2000),
    SUMMARY_TARGET_TOKENS: z.coerce.number().int().positive().default(300),
    EMBED_MAX_INPUT_TOKENS: z.coerce.number().int().positive().optional(),
    LLM_MAX_CONTEXT_TOKENS: z.coerce.number().int().positive().optional(),
    MAX_BODY_BYTES: z.coerce.number().int().positive().default(10_000_000),

    // OKF vault: one-way markdown projection of research + knowledge docs.
    OKF_ENABLED: boolEnv(false),
    OKF_DIR: z.string().default('./.okf-vault'),

    // Knowledge attachments: filesystem blob store + multimodal extraction.
    KNOWLEDGE_BLOB_DIR: z.string().default('./.knowledge-blobs'),
    KNOWLEDGE_MAX_ATTACHMENT_BYTES: z.coerce.number().int().positive().default(26_214_400), // 25 MiB
    // Vision/transcription providers for extracting searchable text from
    // image/audio attachments. 'auto' picks an available provider by API key;
    // 'none' stores+serves the blob but skips text extraction.
    KNOWLEDGE_VISION_PROVIDER: z.enum(['auto', 'none', 'openai', 'anthropic']).default('auto'),
    KNOWLEDGE_VISION_MODEL: z.string().optional(),
    KNOWLEDGE_TRANSCRIBE_PROVIDER: z.enum(['auto', 'none', 'openai']).default('auto'),
    KNOWLEDGE_TRANSCRIBE_MODEL: z.string().default('whisper-1'),

    // Dream cycle bounds.
    DREAM_MAX_EPISODES_PER_RUN: z.coerce.number().int().positive().default(50),
    DREAM_DEADLINE_MS: z.coerce.number().int().positive().default(300_000),

    // Knowledge-graph construction (dream cycle, off the hot path). Relation
    // extraction builds (:Entity)-[:RELATES]->(:Entity) triples; entity
    // resolution re-embeds entities by name and adds :SYNONYM alias edges.
    DREAM_ENABLE_RELATION_EXTRACTION: boolEnv(true),
    DREAM_RELATION_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.6),
    DREAM_ENABLE_ENTITY_RESOLUTION: boolEnv(true),
    DREAM_ENTITY_SYNONYM_THRESHOLD: z.coerce.number().min(0).max(1).default(0.9),
    DREAM_ENTITY_SYNONYM_CANDIDATES: z.coerce.number().int().positive().default(5),

    // Fact hygiene (dream cycle). Dedup skips a new fact whose cosine to an
    // existing live fact exceeds the threshold; supersede/promote gates mirror
    // the previously hardcoded constants in DreamingService.
    DREAM_DEDUP_THRESHOLD: z.coerce.number().min(0).max(1).default(0.92),
    DREAM_SUPERSEDE_VECTOR_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),
    DREAM_PROMOTE_INSIGHT_IMPORTANCE: z.coerce.number().min(0).max(1).default(0.85),
    // Cross-scope dedup lets a project episode dedup/supersede against the
    // unscoped personal bucket (never another project's bucket).
    DREAM_CROSS_SCOPE_DEDUP: boolEnv(true),
    // Pruning: facts at or above the exemption importance never auto-prune;
    // below it, retention follows an importance- and reference-scaled
    // Ebbinghaus curve once past the window.
    DREAM_PRUNE_WINDOW_DAYS: z.coerce.number().int().positive().default(30),
    DREAM_PRUNE_BATCH_LIMIT: z.coerce.number().int().positive().default(1000),
    DREAM_PRUNE_IMPORTANCE_EXEMPT: z.coerce.number().min(0).max(1).default(0.75),
    DREAM_PRUNE_RETENTION_FLOOR: z.coerce.number().min(0).max(1).default(0.05),
    // Consolidation: merge complementary fragment facts about one entity into
    // a single canonical fact (LLM-judged, entity-anchored clusters).
    DREAM_ENABLE_CONSOLIDATION: boolEnv(true),
    DREAM_CONSOLIDATION_MAX_CLUSTERS_PER_RUN: z.coerce.number().int().positive().default(10),
    DREAM_CONSOLIDATION_MAX_CLUSTER_SIZE: z.coerce.number().int().min(2).default(6),
    DREAM_CONSOLIDATION_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.8),
    DREAM_CONSOLIDATION_MIN_ENTITY_FACTS: z.coerce.number().int().min(2).default(3),

    // HippoRAG-style Personalized PageRank retrieval. OFF by default — the
    // default recall pipeline is unchanged when disabled. The GDS projection is
    // refreshed at the end of each dream cycle when this is on.
    RETRIEVAL_ENABLE_PPR: boolEnv(false),
    RETRIEVAL_PPR_BUDGET: z.coerce.number().int().positive().default(30),
    RETRIEVAL_PPR_SEED_TOP_FACTS: z.coerce.number().int().positive().default(10),
    RETRIEVAL_PPR_QUERY_ENTITY_LINKS: z.coerce.number().int().positive().default(5),
    RETRIEVAL_PPR_DAMPING: z.coerce.number().min(0).max(1).default(0.85),
    RETRIEVAL_PPR_MAX_ITER: z.coerce.number().int().positive().default(20),
    RETRIEVAL_PPR_DAMP_FACTOR: z.coerce.number().min(0).max(1).default(0.5),
    RETRIEVAL_PPR_USE_RECOGNITION_FILTER: boolEnv(false),

    // Retrieval pipeline config. See src/services/retrieval/config.ts.
    RETRIEVAL_ENABLE_CHUNKS: boolEnv(true),
    RETRIEVAL_ENABLE_SIBLING_EXPANSION: boolEnv(true),
    RETRIEVAL_SIBLING_BUDGET: z.coerce.number().int().positive().default(20),
    RETRIEVAL_CHUNK_NEIGHBOR_RADIUS: z.coerce.number().int().min(1).max(3).default(1),
    RETRIEVAL_ENABLE_RERANK: boolEnv(false),
    RETRIEVAL_RERANK_TOP_K: z.coerce.number().int().positive().default(20),
    RETRIEVAL_RERANK_KEEP_K: z.coerce.number().int().positive().default(10),
    RETRIEVAL_OVERFETCH_MULTIPLIER: z.coerce.number().int().positive().default(3),
    RETRIEVAL_RRF_K: z.coerce.number().int().positive().default(60),
    RETRIEVAL_WEIGHT_RRF: z.coerce.number().min(0).max(1).default(0.5),
    RETRIEVAL_WEIGHT_IMPORTANCE: z.coerce.number().min(0).max(1).default(0.2),
    RETRIEVAL_WEIGHT_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.1),
    RETRIEVAL_WEIGHT_RECENCY: z.coerce.number().min(0).max(1).default(0.1),
    RETRIEVAL_WEIGHT_REF_COUNT: z.coerce.number().min(0).max(1).default(0.1),
    RETRIEVAL_RECENCY_HALF_LIFE_DAYS: z.coerce.number().int().positive().default(30),
    RETRIEVAL_OWN_AGENT_BOOST: z.coerce.number().min(1).default(1.15),
    RETRIEVAL_SAME_SESSION_BOOST: z.coerce.number().min(1).default(1.05),
    RETRIEVAL_REFCOUNT_TICK_MODE: z.enum(['async', 'sync', 'off']).default('async'),
  })
  .superRefine((env, ctx) => {
    if (env.MEMORY_LLM_PROVIDER === 'anthropic' && !env.ANTHROPIC_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ANTHROPIC_API_KEY'],
        message: 'ANTHROPIC_API_KEY required when MEMORY_LLM_PROVIDER=anthropic',
      });
    }
    if (env.MEMORY_LLM_PROVIDER === 'openai' && !env.OPENAI_API_KEY && !env.OPENAI_BASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OPENAI_API_KEY'],
        message:
          'OPENAI_API_KEY or OPENAI_BASE_URL required when MEMORY_LLM_PROVIDER=openai (base URL only is OK for local OpenAI-compatible servers)',
      });
    }
    if (env.MEMORY_LLM_PROVIDER === 'llamacpp' && !env.LLAMACPP_BASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['LLAMACPP_BASE_URL'],
        message: 'LLAMACPP_BASE_URL required when MEMORY_LLM_PROVIDER=llamacpp',
      });
    }
    if (env.MEMORY_EMBED_PROVIDER === 'openai' && !env.OPENAI_API_KEY && !env.OPENAI_BASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OPENAI_API_KEY'],
        message: 'OPENAI_API_KEY or OPENAI_BASE_URL required when MEMORY_EMBED_PROVIDER=openai',
      });
    }
    if (env.MEMORY_EMBED_PROVIDER === 'ollama' && !env.OLLAMA_BASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OLLAMA_BASE_URL'],
        message: 'OLLAMA_BASE_URL required when MEMORY_EMBED_PROVIDER=ollama',
      });
    }
    if (env.WORKING_STATE_BACKEND === 'redis' && !env.REDIS_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['REDIS_URL'],
        message: 'REDIS_URL required when WORKING_STATE_BACKEND=redis',
      });
    }
    const weightSum =
      env.RETRIEVAL_WEIGHT_RRF +
      env.RETRIEVAL_WEIGHT_IMPORTANCE +
      env.RETRIEVAL_WEIGHT_CONFIDENCE +
      env.RETRIEVAL_WEIGHT_RECENCY +
      env.RETRIEVAL_WEIGHT_REF_COUNT;
    if (Math.abs(weightSum - 1.0) > 0.01) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RETRIEVAL_WEIGHT_RRF'],
        message: `Retrieval weights must sum to 1.0 (±0.01). Current sum: ${weightSum.toFixed(3)}`,
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = result.data;
  return cached;
}

// Reset the cache. Test-only.
export function __resetEnvForTests(): void {
  cached = undefined;
}
