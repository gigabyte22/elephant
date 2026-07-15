// Per-kind visual tokens used by the Sigma canvas, search results, and the
// inspector. Accent palette — magenta-pink as primary memory tone, cyan as the
// relational connector, cool grays for ground-truth content (chunks, knowledge),
// desaturated rose for ephemeral memory (episodes, observations).

export interface KindStyle {
  color: string;
  size: number; // Sigma node size
}

const STYLE: Record<string, KindStyle> = {
  // Primary memory — hot pink, the loudest projection.
  fact: { color: '#FF5C8A', size: 10 },
  insight: { color: '#FF8AB8', size: 9 },
  procedure: { color: '#C7456E', size: 9 },

  // Connectors / relational shapes — electric cyan.
  entity: { color: '#5EE3D8', size: 8 },
  preference: { color: '#3FB8AE', size: 7 },
  research: { color: '#7AB8FF', size: 8 },

  // Ground truth / source content — cool neutral grays.
  chunk: { color: '#A4A0B5', size: 6 },
  knowledge_chunk: { color: '#C2BFD0', size: 6 },
  knowledgechunk: { color: '#C2BFD0', size: 6 },
  knowledge_document: { color: '#C2BFD0', size: 9 },
  knowledgedocument: { color: '#C2BFD0', size: 9 },

  // Ephemeral memory — desaturated rose tones.
  episode: { color: '#8A7F94', size: 8 },
  observation: { color: '#6A6580', size: 6 },
};

export function styleForKind(kind: string): KindStyle {
  return STYLE[kind] ?? { color: '#3D3A4C', size: 5 };
}
