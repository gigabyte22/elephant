// Compact text rendering of elephant wire results for tool responses. The
// consumer is an LLM: ids stay visible (needed for memory_forget), scores are
// rounded, and empty sections are omitted entirely.

import type { RecallResult, WireFact, WirePreference } from '@elephant/client';

export function formatFactLine(f: WireFact & { score?: number }): string {
  const bits: string[] = [];
  if (f.score !== undefined) bits.push(f.score.toFixed(2));
  if (f.category) bits.push(f.category);
  const meta = bits.length ? ` (${bits.join(', ')})` : '';
  const valid = f.validTo ? ` [superseded ${f.validTo.slice(0, 10)}]` : '';
  return `- [${f.id}]${meta} ${f.content}${valid}`;
}

export function formatPreference(p: WirePreference): string {
  return `- ${p.key}: ${p.value}`;
}

export function formatRecall(r: RecallResult): string {
  const sections: string[] = [];
  if (r.preferences?.length) {
    sections.push(`Preferences:\n${r.preferences.map(formatPreference).join('\n')}`);
  }
  if (r.facts.length) {
    sections.push(`Facts:\n${r.facts.map(formatFactLine).join('\n')}`);
  }
  if (r.insights?.length) {
    sections.push(`Insights:\n${r.insights.map((i) => `- ${i.content}`).join('\n')}`);
  }
  if (r.procedures?.length) {
    sections.push(
      `Procedures:\n${r.procedures.map((p) => `- ${p.name} (v${p.version}): ${p.whenToUse}`).join('\n')}`,
    );
  }
  if (r.knowledgeChunks?.length) {
    sections.push(
      `Knowledge:\n${r.knowledgeChunks.map((k) => `- [${k.documentId}] ${k.text.slice(0, 300)}`).join('\n')}`,
    );
  }
  return sections.length ? sections.join('\n\n') : 'No matches.';
}

export function textResult(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}
