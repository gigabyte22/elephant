import Anthropic from '@anthropic-ai/sdk';
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

interface AnthropicAdapterConfig {
  apiKey: string;
  extractionModel: string;
  dreamingModel: string;
  maxContextTokens?: number;
}

// Claude 4.x models ship with 200k context (Opus 4.7 offers a 1M mode behind a
// flag, but staying conservative lets us pick the smaller default without an
// env knob).
const DEFAULT_MAX_CONTEXT_TOKENS = 200_000;

export function createAnthropicLLMAdapter(config: AnthropicAdapterConfig): LLMAdapter {
  const client = new Anthropic({ apiKey: config.apiKey });
  const maxContextTokens = config.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;

  return {
    name: `anthropic(${config.extractionModel}/${config.dreamingModel})`,
    maxContextTokens,
    async countTokens(text: string): Promise<number> {
      return approxTokens(text);
    },

    async extractFacts(input: {
      episode: Episode;
      existingFacts?: Pick<Fact, 'id' | 'content'>[];
    }): Promise<ExtractedFact[]> {
      const userPrompt = buildExtractFactsUserPrompt(input.episode, input.existingFacts ?? []);
      const response = await client.messages.create({
        model: config.extractionModel,
        max_tokens: 8192,
        system: EXTRACT_FACTS_SYSTEM,
        messages: [{ role: 'user', content: userPrompt }],
      });
      const text = textContent(response.content);
      if (response.stop_reason === 'max_tokens') {
        throw new JsonExtractionError(
          `LLM response truncated at max_tokens (stop_reason=max_tokens, ${text.length} chars produced)`,
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
      const response = await client.messages.create({
        model: config.extractionModel,
        max_tokens: 4096,
        system: EXTRACT_RELATIONS_SYSTEM,
        messages: [
          {
            role: 'user',
            content: `Entities:\n${entityList}\n\nConversation turn:\n${input.text}\n\nExtract relationships as JSON.`,
          },
        ],
      });
      const text = textContent(response.content);
      if (response.stop_reason === 'max_tokens') {
        throw new JsonExtractionError(
          `LLM response truncated at max_tokens (stop_reason=max_tokens, ${text.length} chars produced)`,
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
      const userPrompt = buildSupersedeUserPrompt(input.candidate, input.existing);
      const response = await client.messages.create({
        model: config.dreamingModel,
        max_tokens: 1024,
        system: SUPERSEDE_SYSTEM,
        messages: [{ role: 'user', content: userPrompt }],
      });
      const text = textContent(response.content);
      if (response.stop_reason === 'max_tokens') {
        throw new JsonExtractionError(
          `LLM response truncated at max_tokens (stop_reason=max_tokens, ${text.length} chars produced)`,
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
      const response = await client.messages.create({
        model: config.dreamingModel,
        max_tokens: 1024,
        system: CONSOLIDATE_FACTS_SYSTEM,
        messages: [{ role: 'user', content: buildConsolidateUserPrompt(input.cluster) }],
      });
      const text = textContent(response.content);
      if (response.stop_reason === 'max_tokens') {
        throw new JsonExtractionError(
          `LLM response truncated at max_tokens (stop_reason=max_tokens, ${text.length} chars produced)`,
          text,
        );
      }
      return parseJsonResponse(text, ConsolidateResponseSchema);
    },

    async summarize(input: { text: string; targetTokens?: number }): Promise<string> {
      const target = input.targetTokens ?? 300;
      const response = await client.messages.create({
        model: config.extractionModel,
        // Give the model ~20% headroom over the stated target so it doesn't
        // have to cut off mid-sentence to hit the limit.
        max_tokens: Math.ceil(target * 1.2),
        system: SUMMARIZE_SYSTEM,
        messages: [
          {
            role: 'user',
            content: `Summarize the following transcript in at most ${target} tokens (~${target * 4} characters).\n\n---\n${input.text}\n---`,
          },
        ],
      });
      return textContent(response.content).trim();
    },

    async rerank(input) {
      if (input.candidates.length === 0) return [];
      const response = await client.messages.create({
        model: config.extractionModel,
        max_tokens: 2048,
        system: RERANK_SYSTEM,
        messages: [
          {
            role: 'user',
            content: JSON.stringify({
              query: input.query,
              candidates: input.candidates,
            }),
          },
        ],
      });
      const text = textContent(response.content);
      return parseJsonResponse(text, RerankResponseSchema).ranked;
    },
  };
}

function buildSupersedeUserPrompt(
  candidate: Pick<Fact, 'id' | 'content'>,
  existing: Pick<Fact, 'id' | 'content'>[],
): string {
  const list = existing.map((f) => `[${f.id}] ${f.content}`).join('\n');
  return `New fact:
${candidate.content}

Existing facts (with ids):
${list}

Decide.`;
}

function textContent(blocks: Anthropic.ContentBlock[]): string {
  return blocks
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}
