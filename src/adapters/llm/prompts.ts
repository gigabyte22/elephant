// Centralised system prompts. Keeping them out of the adapter code so all
// providers share the exact same instructions — useful when comparing
// extraction quality across models.

export const EXTRACT_FACTS_SYSTEM = `You extract durable facts from a single conversation turn.

A "fact" is a claim that should still be true tomorrow:
- preferences (the user prefers X over Y)
- attributes (the user lives in Berlin)
- decisions (the team chose Postgres over MySQL on 2026-03-15)
- relationships (Alice manages Bob)

NOT facts:
- moment-to-moment intents ("I'm about to read this file")
- rephrasings of existing facts you already know
- ephemeral observations ("the build is currently failing")
- environment-dependent failures ("service X was down", timeouts, rate limits)
- negative tool-capability claims ("tool Y cannot do Z") — failed attempts are
  usually transient errors or misuse, not durable truths about the tool
- operational or run telemetry: tool-call counts, run/job outcomes, cron
  completion reports, "archived N items", "scanned N skills", agent housekeeping
- instantaneous sensor or metric readings ("Body Battery is 52%", step counts,
  CPU load) — the reading changes hourly. A durable PATTERN is a fact ("the
  user tracks sleep with a Garmin watch"); the current value is not.

Speaker attribution — the transcript labels each turn:
- "USER:" is the human. Only USER turns state things about the user.
- "ASSISTANT:" is the AI assistant; "TOOL:" is machine tool output.
- "SYSTEM TRIGGER (CRON):" / "SYSTEM TRIGGER (EVENT):" are machine-generated
  triggers — not a human. A USER turn whose text begins with "[CRON_TRIGGER"
  or "[EVENT_TRIGGER" is likewise machine-generated, not the human user.
Actions performed by the assistant or its tools are attributed to the
assistant ("the assistant subscribed to channel X"), and are only worth
extracting when they establish durable state (a subscription now exists, a
file was permanently created, a configuration changed). Never write "the user
did X" unless a genuine USER turn shows the user doing or saying it.

Importance calibration:
- 0.9-1.0: core identity and biography — family members' names, health
  conditions, where the user lives, who they are
- 0.7-0.8: durable preferences, decisions, relationships
- 0.5-0.6: project-level context likely to matter for weeks
- 0.3-0.4: minor or situational details
- below 0.3: not worth remembering — do not extract it

For each fact, identify the named entities it is about and classify each one's
type (e.g. person, project, tool, organization, place, concept). Lowercase entity
names if they're common nouns; keep proper nouns capitalised.

Return strict JSON only, matching this schema:

{
  "facts": [
    {
      "content": "string — the fact itself, declarative, single sentence",
      "category": "string — optional, e.g. preference, attribute, decision, relationship",
      "confidence": 0.0..1.0,
      "importance": 0.0..1.0,
      "entities": [
        { "name": "string", "type": "person|project|tool|organization|place|concept|..." },
        ...
      ]
    }
  ]
}

If there are no extractable facts, return {"facts": []}. Do not include commentary, markdown fences, or reasoning. Output the JSON object as your entire response.`;

// Shared user-prompt builder for extractFacts, so the Anthropic and OpenAI
// adapters can't drift (they previously did: one sent session/timestamp, the
// other didn't). The episode's origin appends a provenance hint that steers
// attribution for autonomous runs and ingested content.
export function buildExtractFactsUserPrompt(
  episode: {
    sessionId: string;
    timestamp: Date;
    rawTranscript: string;
    origin?: 'user' | 'cron' | 'event' | 'system' | 'ingest';
  },
  existing: Array<{ id: string; content: string }>,
): string {
  const ctx =
    existing.length > 0
      ? `Already-known related facts (avoid trivially restating these):\n${existing
          .map((f) => `- ${f.content}`)
          .join('\n')}\n\n`
      : '';
  let originNote = '';
  if (episode.origin === 'cron' || episode.origin === 'event' || episode.origin === 'system') {
    originNote =
      '\n\nNOTE: This transcript is an autonomous scheduled/triggered run. No human user is present; any USER-labeled trigger text is machine-generated. Do not attribute actions or intents to "the user".';
  } else if (episode.origin === 'ingest') {
    originNote =
      '\n\nNOTE: This is ingested content (a document, article, or media transcript), not a conversation with the user. Attribute claims to the content or its source, not to "the user", unless the content is explicitly the user\'s own first-person writing.';
  }
  return `${ctx}Conversation turn (session=${episode.sessionId}, time=${episode.timestamp.toISOString()}):

${episode.rawTranscript}${originNote}

Extract facts as JSON.`;
}

export const EXTRACT_RELATIONS_SYSTEM = `You extract relationships (triples) between named entities from a conversation turn.

You are given the entities already identified in this turn. Emit directed relationships
ONLY between entities in that list — never invent entity names not provided.

A relationship is a durable, factual connection between two of the given entities:
- "Alice manages Bob"          → { "subject": "Alice", "predicate": "manages", "object": "Bob" }
- "the team chose Postgres"     → { "subject": "team", "predicate": "chose", "object": "Postgres" }
- "Berlin is in Germany"        → { "subject": "Berlin", "predicate": "located_in", "object": "Germany" }
- "the API depends on Redis"    → { "subject": "API", "predicate": "depends_on", "object": "Redis" }

NOT relationships:
- ephemeral or hypothetical connections ("might use", "was thinking about")
- a connection where either side is not in the provided entity list

Rules:
- "subject" and "object" MUST each match (case-insensitively) a name in the provided entity list.
- "predicate": a short lowercase verb phrase joined by underscores (manages, works_at, located_in, chose, depends_on, member_of).
- "confidence": 0.0..1.0.

Return strict JSON only, matching this schema:

{
  "relations": [
    { "subject": "string", "predicate": "string", "object": "string", "confidence": 0.0..1.0 },
    ...
  ]
}

If there are no relationships among the given entities, return {"relations": []}. Do not include commentary, markdown fences, or reasoning. Output the JSON object as your entire response.`;

export const SUPERSEDE_SYSTEM = `You decide whether a new fact supersedes (replaces) an existing fact.

Supersede happens when:
- The new fact directly contradicts the old one ("user prefers light mode" supersedes "user prefers dark mode").
- The new fact is a more specific or more recent version of the same claim.

Supersede does NOT happen when:
- The facts are merely related but compatible.
- The new fact adds detail without invalidating the old one.

Return strict JSON only:

{
  "supersedes": "fact_id_to_supersede" | null,
  "reason": "≤ 15 words, one short sentence",
  "confidenceDelta": -1.0..1.0
}

"confidenceDelta" is the adjustment to apply to the NEW fact's confidence given what
you saw: positive (up to +1.0) when the new fact clearly and recently overrides the
old one (strengthening certainty), negative (down to -1.0) when the two only weakly
conflict and the new claim is itself shaky, 0.0 when you're unsure. It is ignored if
"supersedes" is null.

Only output one supersede target. If multiple existing facts conflict, pick the most directly contradicted one. Keep "reason" to one short sentence (≤ 15 words) — the audit trail just needs the bare why, not a long justification. Output the JSON object as your entire response — no commentary, no markdown, no reasoning.`;

export const CONSOLIDATE_FACTS_SYSTEM = `You consolidate a memory store. You are given a small cluster of stored facts that are all about the same subject. Decide whether some of them state the SAME underlying knowledge in fragments; if so, merge those fragments into one canonical fact.

Merge when facts are complementary fragments of one piece of knowledge:
- "The user's oldest daughter is named Isabelle" + "The user has a daughter named Isabelle who is 6 years old"
  → "The user's oldest daughter, Isabelle, is 6 years old."
- Two facts that say the identical thing in different words.

Do NOT merge when facts carry independent information:
- "The user prefers dark mode" + "The user's daughter is named Isabelle" — related to the same person, but independent claims. Return "keep".
- Facts about different people, projects, or time periods, even if superficially similar.
- Facts that contradict each other — that is a supersede problem, not a merge. Return "keep".

Rules for the merged fact:
- One declarative sentence, at most two clauses, under 280 characters.
- Preserve EVERY concrete detail from the merged fragments: names, numbers, dates, ages, ordinals ("oldest"), locations. Losing a detail is worse than not merging.
- Invent nothing. If two fragments disagree on a detail, return "keep".
- "mergeFactIds" lists the ids of the facts folded into the merged sentence — at least 2, and it may be a strict subset of the cluster (leave genuinely distinct facts out).

Return strict JSON only:

{
  "decision": "merge" | "keep",
  "mergeFactIds": ["id", ...],
  "content": "string — the merged fact; empty string when decision is keep",
  "category": "string — optional, e.g. attribute, preference",
  "confidence": 0.0..1.0,
  "importance": 0.0..1.0
}

When decision is "keep", return {"decision":"keep","mergeFactIds":[],"content":"","confidence":0.0,"importance":0.0}. Do not include commentary, markdown fences, or reasoning. Output the JSON object as your entire response.`;

export function buildConsolidateUserPrompt(
  cluster: Array<{
    id: string;
    content: string;
    category?: string;
    confidence: number;
    importance: number;
  }>,
): string {
  const lines = cluster.map(
    (f) =>
      `[${f.id}] ${f.content} (category=${f.category ?? 'none'}, confidence=${f.confidence}, importance=${f.importance})`,
  );
  return `Stored facts about one subject:\n\n${lines.join('\n')}\n\nDecide merge or keep as JSON.`;
}

export const RERANK_SYSTEM = `You re-rank candidate memory facts against a query.

Inputs:
- "query": the user's natural-language query.
- "candidates": a list of memory facts, each with an "id" and a "content".

Task: score each candidate by its *direct usefulness for answering or acting on the query* on a scale of 0.0 to 1.0 where:
- 1.0 = directly answers or is unambiguously about the query
- 0.6..0.9 = closely related, would substantially help the caller
- 0.2..0.5 = loosely related, topical context only
- 0.0..0.1 = off-topic, noise, or stale/irrelevant claims

Return strict JSON only, matching this schema:

{
  "ranked": [
    { "id": "candidate_id", "score": 0.0..1.0, "reason": "short phrase — optional" },
    ...
  ]
}

Rules:
- Return ALL input candidates (with their scores), not just the top K — the caller handles cut-off.
- Order the list from highest score to lowest.
- Do not invent candidates not in the input.
- Do not include markdown fences, commentary, or chain-of-thought. Output the JSON object as your entire response.`;

export const SUMMARIZE_SYSTEM = `You produce a tight, factual summary of a conversation transcript.

Constraints:
- Preserve who said what, which decisions were made, and concrete details (names, numbers, dates, tools).
- Drop filler, pleasantries, and side-chatter.
- Do not editorialise or add information not in the source.
- Write in third-person, past tense, short declarative sentences.
- Target the length requested by the user; never exceed it.

Output the summary as plain text. No preamble, no markdown headings, no bullet points.`;
