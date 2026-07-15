import OpenAI from 'openai';
import type {
  Episode,
  ExtractedFact,
  ExtractedRelation,
  Fact,
  SupersedeDecision,
} from '../../models/types.ts';
import { approxTokens } from '../../utils/tokens.ts';
import {
  ConsolidateResponseSchema,
  ExtractFactsResponseSchema,
  ExtractRelationsResponseSchema,
  JsonExtractionError,
  RerankResponseSchema,
  SupersedeResponseSchema,
  parseJsonResponse,
} from './json-prompt.ts';
import {
  CONSOLIDATE_FACTS_SYSTEM,
  EXTRACT_FACTS_SYSTEM,
  EXTRACT_RELATIONS_SYSTEM,
  RERANK_SYSTEM,
  SUMMARIZE_SYSTEM,
  SUPERSEDE_SYSTEM,
  buildConsolidateUserPrompt,
  buildExtractFactsUserPrompt,
} from './prompts.ts';
import type { LLMAdapter } from './types.ts';

interface OpenAIAdapterConfig {
  apiKey?: string;
  baseURL?: string;
  model: string;
  maxContextTokens?: number;
}

// gpt-4.1 family is 128k; gpt-4o and older are 128k. Conservative default
// that's also reasonable for most local OpenAI-compatible servers.
const DEFAULT_MAX_CONTEXT_TOKENS = 128_000;

export function createOpenAILLMAdapter(config: OpenAIAdapterConfig): LLMAdapter {
  const client = new OpenAI({
    apiKey: config.apiKey ?? 'unused',
    baseURL: config.baseURL,
  });
  const maxContextTokens = config.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;

  return {
    name: `openai(${config.model}${config.baseURL ? `@${config.baseURL}` : ''})`,
    maxContextTokens,
    async countTokens(text: string): Promise<number> {
      return approxTokens(text);
    },

    async extractFacts(input: {
      episode: Episode;
      existingFacts?: Pick<Fact, 'id' | 'content'>[];
    }): Promise<ExtractedFact[]> {
      const response = await client.chat.completions.create({
        model: config.model,
        max_tokens: 8192,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: EXTRACT_FACTS_SYSTEM },
          {
            role: 'user',
            content: buildExtractFactsUserPrompt(input.episode, input.existingFacts ?? []),
          },
        ],
      });
      const text = response.choices[0]?.message?.content ?? '';
      if (response.choices[0]?.finish_reason === 'length') {
        throw new JsonExtractionError(
          `LLM response truncated at max_tokens (finish_reason=length, ${text.length} chars produced)`,
          text,
        );
      }
      return parseJsonResponse(text, ExtractFactsResponseSchema).facts;
    },

    async extractRelations(input: {
      text: string;
      entities: Array<{ name: string; type: string }>;
    }): Promise<ExtractedRelation[]> {
      // Nothing to relate with fewer than two entities.
      if (input.entities.length < 2) return [];
      const entityList = input.entities.map((e) => `- ${e.name} (${e.type})`).join('\n');
      const response = await client.chat.completions.create({
        model: config.model,
        max_tokens: 4096,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: EXTRACT_RELATIONS_SYSTEM },
          {
            role: 'user',
            content: `Entities:\n${entityList}\n\nConversation turn:\n${input.text}\n\nExtract relationships as JSON.`,
          },
        ],
      });
      const text = response.choices[0]?.message?.content ?? '';
      if (response.choices[0]?.finish_reason === 'length') {
        throw new JsonExtractionError(
          `LLM response truncated at max_tokens (finish_reason=length, ${text.length} chars produced)`,
          text,
        );
      }
      return parseJsonResponse(text, ExtractRelationsResponseSchema).relations;
    },

    async detectSupersede(input: {
      candidate: Pick<Fact, 'id' | 'content'>;
      existing: Pick<Fact, 'id' | 'content'>[];
    }): Promise<Omit<SupersedeDecision, 'newFactId'> | null> {
      if (input.existing.length === 0) return null;
      const list = input.existing.map((f) => `[${f.id}] ${f.content}`).join('\n');
      const response = await client.chat.completions.create({
        model: config.model,
        max_tokens: 4096,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SUPERSEDE_SYSTEM },
          {
            role: 'user',
            content: `New fact:\n${input.candidate.content}\n\nExisting facts:\n${list}\n\nDecide.`,
          },
        ],
      });
      const text = response.choices[0]?.message?.content ?? '';
      if (response.choices[0]?.finish_reason === 'length') {
        throw new JsonExtractionError(
          `LLM response truncated at max_tokens (finish_reason=length, ${text.length} chars produced)`,
          text,
        );
      }
      const parsed = parseJsonResponse(text, SupersedeResponseSchema);
      if (!parsed.supersedes) return null;
      return {
        oldFactId: parsed.supersedes,
        reason: parsed.reason,
        confidenceDelta: parsed.confidenceDelta,
      };
    },

    async consolidateFacts(input) {
      if (input.cluster.length < 2) return null;
      const response = await client.chat.completions.create({
        model: config.model,
        max_tokens: 1024,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: CONSOLIDATE_FACTS_SYSTEM },
          { role: 'user', content: buildConsolidateUserPrompt(input.cluster) },
        ],
      });
      const text = response.choices[0]?.message?.content ?? '';
      if (response.choices[0]?.finish_reason === 'length') {
        throw new JsonExtractionError(
          `LLM response truncated at max_tokens (finish_reason=length, ${text.length} chars produced)`,
          text,
        );
      }
      return parseJsonResponse(text, ConsolidateResponseSchema);
    },

    async summarize(input: { text: string; targetTokens?: number }): Promise<string> {
      const target = input.targetTokens ?? 300;
      const response = await client.chat.completions.create({
        model: config.model,
        max_tokens: Math.ceil(target * 1.2),
        messages: [
          { role: 'system', content: SUMMARIZE_SYSTEM },
          {
            role: 'user',
            content: `Summarize the following transcript in at most ${target} tokens (~${target * 4} characters).\n\n---\n${input.text}\n---`,
          },
        ],
      });
      return (response.choices[0]?.message?.content ?? '').trim();
    },

    async rerank(input) {
      if (input.candidates.length === 0) return [];
      const response = await client.chat.completions.create({
        model: config.model,
        max_tokens: 2048,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: RERANK_SYSTEM },
          {
            role: 'user',
            content: JSON.stringify({ query: input.query, candidates: input.candidates }),
          },
        ],
      });
      const text = response.choices[0]?.message?.content ?? '';
      return parseJsonResponse(text, RerankResponseSchema).ranked;
    },
  };
}
