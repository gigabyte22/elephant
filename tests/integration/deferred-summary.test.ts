// POST /episodes no longer summarizes in the request.
//
// Summarizing a long transcript is a map-reduce of several sequential LLM
// calls. Doing it inline was the last blocking model call on the write path,
// and the slowest: a caller posting a big transcript waited on all of it.
// Ingestion now stores a clipped head and the dream cycle installs the real
// summary — which is only acceptable if the cycle actually does, and if the
// transcript stays searchable meanwhile. That is what these pin.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { read, write as txWrite } from '../../src/config/neo4j.ts';
import { bootstrap, type Container, shutdown } from '../../src/index.ts';
import { EpisodeRepository } from '../../src/repositories/EpisodeRepository.ts';
import { assertDestructiveAllowed } from './guard.ts';

const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);

// Comfortably past SUMMARY_THRESHOLD_TOKENS (2000), so ingestion summarizes
// rather than using the transcript as its own summary.
const LONG_TRANSCRIPT = Array.from(
  { length: 400 },
  (_, i) => `USER: line ${i} of a long conversation about deploying the service to production.`,
).join('\n');

let container: Container;
let summarizeCalls: number;
let summarizeThrows: boolean;

beforeAll(async () => {
  summarizeCalls = 0;
  summarizeThrows = false;
  container = await bootstrap({
    embedder: createFakeEmbeddingAdapter({ dim: EMBED_DIM }),
    llm: createFakeLLMAdapter({
      summarize: ({ text }) => {
        summarizeCalls += 1;
        if (summarizeThrows) throw new Error('provider unavailable');
        return `[real summary] ${text.slice(0, 40).replace(/\s+/g, ' ').trim()}`;
      },
    }),
  });
});

afterAll(async () => {
  await shutdown();
});

beforeEach(async () => {
  assertDestructiveAllowed();
  summarizeCalls = 0;
  summarizeThrows = false;
  await txWrite(async (tx) => {
    await tx.run('MATCH (n) DETACH DELETE n');
  });
});

async function ingestLong() {
  return container.ingestion.ingestEpisode({
    agentId: 'agent-1',
    sessionId: 'sess-1',
    rawTranscript: LONG_TRANSCRIPT,
  });
}

async function getEpisode(id: string) {
  return read((tx) => EpisodeRepository.get(tx, id));
}

describe('POST /episodes with a long transcript', () => {
  test('returns without summarizing, storing a clipped head marked provisional', async () => {
    const episode = await ingestLong();

    // The assertion that fails if inline summarization is ever reinstated.
    expect(summarizeCalls).toBe(0);

    const stored = await getEpisode(episode.id);
    expect(stored?.summaryProvisional).toBe(true);
    expect(stored?.summary).toBe(LONG_TRANSCRIPT.slice(0, stored!.summary.length));
    expect(stored?.summary.length).toBeLessThan(LONG_TRANSCRIPT.length);
  });

  test('still chunks and embeds the whole transcript, so content recall is unaffected', async () => {
    const episode = await ingestLong();

    // The head-biased summary is an episode-level artefact only. Everything the
    // transcript says is in the chunk index either way, which is what makes the
    // deferral safe rather than lossy.
    const chunks = await read(async (tx) => {
      const r = await tx.run(
        `MATCH (e:Episode {id: $id})-[:HAS_CHUNK]->(c:Chunk)
         RETURN count(c) AS n, sum(size(c.embedding)) AS dims`,
        { id: episode.id },
      );
      return {
        count: Number(r.records[0]?.get('n') ?? 0),
        dims: Number(r.records[0]?.get('dims') ?? 0),
      };
    });
    expect(chunks.count).toBeGreaterThan(1);
    expect(chunks.dims).toBe(chunks.count * EMBED_DIM);
  });

  test('a caller-supplied summary is used as-is and is never provisional', async () => {
    const episode = await container.ingestion.ingestEpisode({
      agentId: 'agent-1',
      sessionId: 'sess-1',
      rawTranscript: LONG_TRANSCRIPT,
      summary: 'The team discussed the production deploy.',
    });

    expect(summarizeCalls).toBe(0);
    const stored = await getEpisode(episode.id);
    expect(stored?.summary).toBe('The team discussed the production deploy.');
    expect(stored?.summaryProvisional ?? false).toBe(false);
  });
});

describe('the dream cycle summary pass', () => {
  test('installs the real summary and re-embeds it', async () => {
    const episode = await ingestLong();
    const before = await getEpisode(episode.id);

    const run = await container.dreaming.runCycle();

    expect(run.summariesInstalled).toBe(1);
    expect(summarizeCalls).toBeGreaterThan(0);

    const after = await getEpisode(episode.id);
    expect(after?.summaryProvisional).toBe(false);
    expect(after?.summary).toContain('[real summary]');
    // Re-embedded, not left pointing at the head's vector — otherwise recall
    // would keep matching the opening lines forever.
    expect(after?.embedding).toHaveLength(EMBED_DIM);
    expect(after?.embedding).not.toEqual(before?.embedding);
  });

  test('claims each episode once', async () => {
    await ingestLong();

    await container.dreaming.runCycle();
    const second = await container.dreaming.runCycle();

    expect(second.summariesInstalled).toBe(0);
  });

  test('keeps the head and retries next cycle when the model is down', async () => {
    const episode = await ingestLong();

    summarizeThrows = true;
    const failed = await container.dreaming.runCycle();

    expect(failed.summariesInstalled).toBe(0);
    expect(failed.status).toBe('completed'); // best-effort: the pass cannot fail the cycle
    expect((await getEpisode(episode.id))?.summaryProvisional).toBe(true);

    summarizeThrows = false;
    const recovered = await container.dreaming.runCycle();

    expect(recovered.summariesInstalled).toBe(1);
    expect((await getEpisode(episode.id))?.summary).toContain('[real summary]');
  });
});
