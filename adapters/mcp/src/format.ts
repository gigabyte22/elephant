// Compact text rendering of elephant wire results for tool responses. The
// consumer is an LLM: ids stay visible (needed for memory_forget), scores are
// rounded, and empty sections are omitted entirely.

import type {
  RecallResult,
  WireFact,
  WireIntention,
  WireKnowledgeDocument,
  WirePreference,
  WireProcedure,
  WireWorkingStateEntry,
} from '@elephant/client';

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

/** A labelled recall section, or nothing at all when it has no items. */
function section<T>(
  label: string,
  items: readonly T[] | undefined,
  render: (item: T) => string,
): string | undefined {
  if (!items?.length) return undefined;
  return `${label}:\n${items.map(render).join('\n')}`;
}

export function formatRecall(r: RecallResult): string {
  const sections = [
    section('Preferences', r.preferences, formatPreference),
    section('Facts', r.facts, formatFactLine),
    section('Insights', r.insights, (i) => `- ${i.content}`),
    section('Procedures', r.procedures, (p) => `- ${p.name} (v${p.version}): ${p.whenToUse}`),
    section('Knowledge', r.knowledgeChunks, (k) => `- [${k.documentId}] ${snip(k.text)}`),
    section(
      'Research',
      r.research,
      (d) => `- [${d.id}] ${d.title}${d.summary ? `: ${snip(d.summary, 200)}` : ''}`,
    ),
    section('Research excerpts', r.researchChunks, (c) => `- [${c.researchId}] ${snip(c.text)}`),
    section('Intentions', r.intentions, formatIntention),
  ].filter((s) => s !== undefined);
  return sections.length ? sections.join('\n\n') : 'No matches.';
}

export function formatIntention(i: WireIntention): string {
  const bits: string[] = [i.status];
  if (i.dueAt) bits.push(`due ${i.dueAt.slice(0, 16).replace('T', ' ')}`);
  if (i.recurring) bits.push(i.schedule ? `recurring ${i.schedule}` : 'recurring');
  if (i.triggerHint) bits.push(`when ${i.triggerHint}`);
  return `- [${i.id}] (${bits.join(', ')}) ${i.content}`;
}

/** One line per document for list views — never the body. */
export function formatDocumentLine(d: WireKnowledgeDocument): string {
  const tags = d.tags.length ? ` #${d.tags.join(' #')}` : '';
  return `- [${d.id}] ${d.title}${tags}${d.summary ? `: ${snip(d.summary, 200)}` : ''}`;
}

/** Full single-document view: the body is the point, so it is not truncated. */
export function formatDocument(d: WireKnowledgeDocument): string {
  const lines = [
    `${d.title} [${d.id}]`,
    `source: ${d.source}${d.sourceUri ? ` (${d.sourceUri})` : ''}`,
  ];
  if (d.tags.length) lines.push(`tags: ${d.tags.join(', ')}`);
  if (d.summary) lines.push(`summary: ${d.summary}`);
  if (d.content) lines.push('', d.content);
  return lines.join('\n');
}

export function formatProcedure(p: WireProcedure): string {
  return [
    `${p.name} (v${p.version}) [${p.id}]`,
    `when: ${p.whenToUse}`,
    `success: ${p.successRate.toFixed(2)} over ${p.invocationCount} runs`,
    '',
    p.content,
  ].join('\n');
}

export function formatStateEntry(e: WireWorkingStateEntry): string {
  const value = typeof e.value === 'string' ? e.value : JSON.stringify(e.value);
  const expires = e.expiresAt ? ` (expires ${e.expiresAt})` : '';
  return `- ${e.key}: ${value}${expires}`;
}

/** Chunk text goes into a model's context — cap it so one document can't
 *  crowd out every other section. */
function snip(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export type TextResult = { content: Array<{ type: 'text'; text: string }> };

export function textResult(text: string): TextResult {
  return { content: [{ type: 'text', text }] };
}

/** Render a list, or a stand-in line when it is empty. */
export function listResult<T>(
  items: readonly T[],
  empty: string,
  render: (item: T) => string,
): TextResult {
  return textResult(items.length ? items.map(render).join('\n') : empty);
}
