import { z } from 'zod';
import { ExtractedFactSchema, ExtractedRelationSchema } from '../../models/types.ts';

// Shared helper: extract a JSON payload from an LLM response and validate it.
// Tolerates models that wrap JSON in fences or add trailing commentary.

// Shared response shapes for the LLM protocol — defined once so Anthropic and
// OpenAI adapters can't drift.
export const ExtractFactsResponseSchema = z.object({ facts: z.array(ExtractedFactSchema) });
export const ExtractRelationsResponseSchema = z.object({
  relations: z.array(ExtractedRelationSchema),
});
export const SupersedeResponseSchema = z.object({
  // Tolerate the model wrapping the id in array brackets ("[uuid]") before validating —
  // observed in practice and would otherwise leak a non-UUID into the audit log.
  supersedes: z
    .string()
    .nullable()
    .transform((s) => (s == null ? null : s.replace(/^\[|\]$/g, '')))
    .pipe(z.string().uuid().nullable()),
  reason: z.string().default(''),
  confidenceDelta: z.number().default(0),
});

export const ConsolidateResponseSchema = z.object({
  decision: z.enum(['merge', 'keep']),
  // Tolerate bracket-wrapped ids like the supersede schema does.
  mergeFactIds: z
    .array(
      z
        .string()
        .transform((s) => s.replace(/^\[|\]$/g, ''))
        .pipe(z.string().uuid()),
    )
    .default([]),
  content: z.string().default(''),
  category: z.string().optional(),
  confidence: z.number().min(0).max(1).default(0.7),
  importance: z.number().min(0).max(1).default(0.5),
});

export const RerankResponseSchema = z.object({
  ranked: z.array(
    z.object({
      id: z.string(),
      score: z.number().min(0).max(1),
      reason: z.string().optional(),
    }),
  ),
});

export class JsonExtractionError extends Error {
  constructor(
    message: string,
    public readonly raw: string,
  ) {
    super(message);
    this.name = 'JsonExtractionError';
  }
}

// Strip reasoning-model artefacts before JSON extraction. Qwen3.5 / DeepSeek-R1
// / o1-style models emit a `<think>…</think>` block before the real answer.
// Handles unclosed `<think>` (model ran out of tokens mid-reasoning) by
// dropping everything from the opening tag onward — there's no answer to keep.
function stripThinkingBlocks(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const orphan = out.search(/<think>/i);
  if (orphan !== -1) out = out.slice(0, orphan);
  return out.trim();
}

export function extractJson(text: string): unknown {
  const cleaned = stripThinkingBlocks(text);
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(cleaned);
  const candidate = fenced ? fenced[1]! : cleaned;
  // Find the first { or [ and the matching last } or ].
  const firstBrace = candidate.search(/[{[]/);
  if (firstBrace === -1) {
    throw new JsonExtractionError('No JSON object or array found in response', text);
  }
  const trimmed = candidate.slice(firstBrace).trim();
  // Walk back from the end to find a balanced closing brace/bracket.
  for (let end = trimmed.length; end > 0; end--) {
    const slice = trimmed.slice(0, end);
    try {
      return JSON.parse(slice);
    } catch {
      // try shorter
    }
  }
  throw new JsonExtractionError('Could not parse balanced JSON from response', text);
}

export function parseJsonResponse<S extends z.ZodTypeAny>(raw: string, schema: S): z.output<S> {
  const json = extractJson(raw);
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new JsonExtractionError(
      `LLM response failed schema validation: ${result.error.message}`,
      raw,
    );
  }
  return result.data;
}
