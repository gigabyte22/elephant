---
title: "Elephant: knowledge documents, research, attachments and the OKF vault"
tags: [elephant, knowledge, research, attachments]
---

Besides conversational memory, Elephant stores longer texts that agents should be able to search: **knowledge
documents** (durable reference material, optionally with file attachments) and **research** (project-scoped,
often expiring notes such as pipeline or web-research output). Both keep their full body on the node, are
chunked and embedded, and are reachable through recall when the caller opts in (`includeKnowledge=1`,
`includeResearch=1`). Optionally both are projected into a markdown vault on disk (OKF).

## Knowledge documents

`POST /knowledge/documents` with `{title, source, content, sourceUri?, summary?, tags?, expiresAt?,
scope?: {projectId, userId}, actor?, id?}`.

- The body is chunked (about 480 tokens, 50 overlap) into `:KnowledgeChunk` nodes and every chunk is embedded.
- The document's summary: the caller's `summary`, or the content itself when it is short, or an **LLM summary**
  when the content exceeds `SUMMARY_THRESHOLD_TOKENS` (2000). Knowledge and research ingestion still summarize
  inline (operator-driven, not the chat hot path), so a long upload waits on the LLM.
- `GET /knowledge/documents/:id` fetches one (with its attachments); `GET /knowledge/documents?projectId=&userId=
  &projectScope=&userScope=&limit=` lists (max 200).
- `PUT /knowledge/documents/:id` updates title/content/summary/tags/expiresAt; the prior state is archived as a
  revision and changed content is re-chunked.
- `DELETE /knowledge/documents/:id` soft-deletes; `?purge=true` also hard-deletes its chunks, attachment nodes
  and blob files.

## Attachments

`POST /knowledge/documents/:id/attachments` with `{filename, mimeType, dataBase64, actor?}`. Limit
`KNOWLEDGE_MAX_ATTACHMENT_BYTES` (25 MiB, raw bytes). The bytes are stored as a file (with their sha256) in
`KNOWLEDGE_BLOB_DIR` (stack: `$STACK_ROOT/data/elephant-blobs`) and the extracted text becomes more knowledge
chunks of that document, so the file's content is searchable through recall.

Extraction is routed by MIME type:

| Type | Extractor | When |
|---|---|---|
| `text/*`, JSON, XML, CSV, YAML, NDJSON, HTML (tags stripped) | local | inline during the upload (up to `KNOWLEDGE_EXTRACT_MAX_TEXT_BYTES`, 2 MiB) |
| PDF with a text layer | local | inline |
| PDF without a text layer (a scan) | pages rendered and sent to the vision model, up to `KNOWLEDGE_PDF_OCR_MAX_PAGES` (10) | background |
| `image/*` | vision model (OCR / description), downscaled to `KNOWLEDGE_VISION_MAX_DIM` (1024 px) first | background |
| `audio/*`, `video/webm`, `video/mp4` | transcription model (Whisper-compatible), max `KNOWLEDGE_TRANSCRIBE_MAX_BYTES` | background |

Anything slow is stored with `extractionStatus: "pending"` and the upload returns at once. The **attachment
extraction worker** (`KNOWLEDGE_EXTRACTION_CRON`, default every 2 minutes) takes **one** pending attachment per
tick, because the vision model typically shares the GPU with the embedder. A structural failure (provider down,
blob missing) is retried with backoff (`KNOWLEDGE_EXTRACTION_MAX_ATTEMPTS` 4, `KNOWLEDGE_EXTRACTION_RETRY_BACKOFF_MS`
5 min base) before it is dead-lettered as `failed`.

`extractionStatus` values: `done`, `pending`, `empty` (ran, found no text), `truncated` (indexed but incomplete,
for example the vision output hit `KNOWLEDGE_VISION_MAX_TOKENS` or the page cap), `unsupported` (no extractor for
the type), `skipped` (no provider configured, or unreadable input), `failed`. Chunks from a model carry
`derivation: "model"`; text taken from the file itself is `verbatim`.

Image OCR and transcription are **off until configured**: see *Elephant: attachment OCR and transcription
settings*. `/health.data.extraction` shows `pending` and `deadLettered` counts.

Other attachment routes: `DELETE /knowledge/documents/:id/attachments/:attachmentId` (removes its chunks, node
and blob) and `GET /knowledge/attachments/:blobId`, which streams the raw file (the only route that does not
return the JSON envelope).

Re-running extraction (after configuring a provider, after a provider outage, or to repair `truncated`):

```bash
cd /home/cerebro/stack/elephant
pnpm backfill:attachment-extraction                       # dry run: lists what would be re-extracted
pnpm backfill:attachment-extraction --yes                 # re-extract unsupported/skipped/failed/pending/truncated
pnpm backfill:attachment-extraction --id=<attachmentId> --yes
pnpm backfill:attachment-extraction --mime-prefix=image/ --limit=10 --yes
KNOWLEDGE_VISION_TIMEOUT_MS=1800000 pnpm backfill:attachment-extraction --yes   # slow local vision model
```

It works one attachment at a time and replaces (never duplicates) an attachment's chunks. `--include-empty`
also retries `empty` results.

## Research

`POST /research` with `{title, source, content, projectId (required), userId?, sourceUri?, summary?, tags?,
expiresAt?, metadata?, actor?, id?}`. `metadata` is a provenance string map (max 20 entries), write-once and never
searched. Bodies are chunked into `:ResearchChunk` with their own indexes.

- `GET /research/:id` (full content), `GET /research?projectId=...` (rows include content; `projectId` required
  unless `projectScope` is explicit), `PUT /research/:id` (revision snapshot; `projectId`/`userId` cannot change),
  `DELETE /research/:id` (soft delete).
- `GET /research/:id/similar?limit=10&minScore=0.85` returns other research close to this one.
- Lapsed research (`expiresAt` in the past) no longer surfaces in recall or lists. It is deleted only when
  `RESEARCH_RETENTION_DAYS` is set: then research whose expiry lapsed that many days ago is purged by the
  research reaper (hourly at :15 by default), chunks and revisions included.

Rule of thumb from the integration guide: generated pipeline output goes to research; promote it to a knowledge
document deliberately.

## The OKF markdown vault

With `OKF_ENABLED=true`, every research item and knowledge document is also written as a markdown file with YAML
frontmatter under `OKF_DIR` (default `./.okf-vault` in the checkout):

```
projects/<projectId>/research/<title-slug>--<id>.md
projects/<projectId>/documents/<title-slug>--<id>.md
projects/<projectId>/_index.md          generated wikilinked index, written only by the sync
shared/documents/<title-slug>--<id>.md   documents with no project
shared/_index.md
_trash/<same path>                       tombstones of deleted, expired or orphaned files
```

- The graph is the source of truth; the vault is derived, one-way output (no import back). The `--<id>` suffix is
  the identity; the slug follows the title.
- Files are written after the graph commit. A failed file write never fails the request; the sync repairs it.
- The sync runs on `OKF_SYNC_CRON` (default `30 3 * * *`) while enabled, and on demand:

```bash
cd /home/cerebro/stack/elephant
pnpm okf:sync --dry-run      # report only
pnpm okf:sync                # write changed files, tombstone expired/orphaned ones, rebuild _index.md
pnpm okf:sync --purge        # also empty _trash/ (the only hard delete; files only)
# --no-reap, --no-index, --force-reap (reap even when the graph returned zero nodes; check OKF_DIR/NEO4J_URI first)
```

Safety gates: only files whose frontmatter has an `id` and known `kind` are touched (anything else is reported
as `foreign`), files modified after the sweep started are left alone, and if the graph returns zero projectable
nodes while the vault is not empty the reap is aborted (exit code 1). The vault is not part of `bin/stack backup`;
it can be regenerated from the graph with `pnpm okf:sync`.
