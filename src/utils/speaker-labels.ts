// Turn-label grammar for episode transcripts, shared by the extraction
// chunk-group packer. Labels start a line: `USER:`, `USER(<label>):`,
// `ASSISTANT:`, `TOOL:`, `SYSTEM TRIGGER (CRON):`, …

const LABEL = /^(USER(?:\([^)\n]{1,64}\))?|ASSISTANT|TOOL|SYSTEM TRIGGER[^:\n]*):/;
// Same grammar, but `m` re-anchors `^` to each line instead of the string.
const LABEL_ALL = new RegExp(LABEL.source, 'gm');

/** True when `text` opens a turn (leading whitespace allowed). */
export function startsWithSpeakerLabel(text: string): boolean {
  return LABEL.test(text.trimStart());
}

/** The last turn label appearing in `text`, or null if it has none. */
export function lastSpeakerLabel(text: string): string | null {
  let last: string | null = null;
  for (const m of text.matchAll(LABEL_ALL)) {
    last = m[1] ?? null;
  }
  return last;
}
