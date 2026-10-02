---
title: "Elephant: attachment OCR and transcription settings"
tags: [elephant, settings, attachments, vision]
---

Image OCR, scanned-PDF OCR and audio transcription send a user's file bytes to a model endpoint, so they are off
until someone says where to send them. These are the `KNOWLEDGE_VISION_*` and `KNOWLEDGE_TRANSCRIBE_*` settings.
They can be set in Elephant's `.env` **or** changed at runtime, without a restart, through an admin API that
stores them encrypted. In Cerebro this API is what the Connections page's "memory-vision" card reads and writes.

## The opt-in rule

| `KNOWLEDGE_VISION_PROVIDER` | Image/scan OCR is... |
|---|---|
| `auto` (default) | on only when dedicated `KNOWLEDGE_VISION_BASE_URL` and/or `KNOWLEDGE_VISION_API_KEY` are set (an OpenAI-compatible endpoint; a local server needs only the URL) |
| `openai` | on, using the dedicated values, falling back to the shared `OPENAI_BASE_URL` / `OPENAI_API_KEY` |
| `anthropic` | on, using `ANTHROPIC_API_KEY` |
| `none` | off: images are stored and served, but not read |

`KNOWLEDGE_TRANSCRIBE_PROVIDER` works the same way with `auto`/`none`/`openai` and
`KNOWLEDGE_TRANSCRIBE_BASE_URL` / `_API_KEY`; the model is `KNOWLEDGE_TRANSCRIBE_MODEL` (default `whisper-1`,
a Whisper-compatible `/audio/transcriptions` endpoint).

Naming a provider without anything to talk to is a startup error, not a silent disable. At boot the service logs
one line per capability, for example `[extraction] image OCR -> openai <model> at <endpoint>` or
`[extraction] image OCR disabled (set KNOWLEDGE_VISION_* credentials, or name a provider to use the shared keys)`.

## All settings in this group

| Variable | Default | Purpose |
|---|---|---|
| `KNOWLEDGE_VISION_PROVIDER` | `auto` | see above |
| `KNOWLEDGE_VISION_MODEL` | `gpt-4o-mini` (openai) or `ANTHROPIC_EXTRACTION_MODEL` (anthropic) | vision model |
| `KNOWLEDGE_VISION_BASE_URL`, `KNOWLEDGE_VISION_API_KEY` | unset | dedicated endpoint/key |
| `KNOWLEDGE_VISION_REASONING_EFFORT` | unset | `none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`, sent to OpenAI-compatible reasoning models; `low` is usually plenty for OCR |
| `KNOWLEDGE_VISION_FALLBACK_PROVIDER`, `_MODEL`, `_BASE_URL`, `_API_KEY`, `_REASONING_EFFORT` | `auto`/unset | optional second tier, tried when the primary errors or its output fails the quality guard; ignored while the primary is off, and dropped if it resolves to the identical call |
| `KNOWLEDGE_VISION_TIMEOUT_MS` | 120000 | per-call ceiling |
| `KNOWLEDGE_VISION_MAX_DIM` | 1024 | images downscaled to this many pixels on the long side before OCR |
| `KNOWLEDGE_VISION_JPEG_QUALITY` | 80 | re-encode quality |
| `KNOWLEDGE_VISION_MAX_TOKENS` | 4096 | output ceiling; hitting it records the attachment as `truncated` |
| `KNOWLEDGE_TRANSCRIBE_PROVIDER`, `_MODEL`, `_BASE_URL`, `_API_KEY` | `auto`, `whisper-1`, unset | transcription |
| `KNOWLEDGE_TRANSCRIBE_TIMEOUT_MS` | 300000 | per-call ceiling |
| `KNOWLEDGE_TRANSCRIBE_MAX_BYTES` | 26214400 | larger audio is refused up front |

Related but not runtime-editable (env only): `KNOWLEDGE_PDF_OCR_MAX_PAGES` (10), `KNOWLEDGE_EXTRACT_MAX_TEXT_BYTES`,
`KNOWLEDGE_EXTRACTION_CRON`, `KNOWLEDGE_EXTRACTION_MAX_ATTEMPTS`, `KNOWLEDGE_EXTRACTION_RETRY_BACKOFF_MS`,
`KNOWLEDGE_MAX_ATTACHMENT_BYTES`, `KNOWLEDGE_BLOB_DIR`.

## The admin API

Both routes need the bearer token.

```bash
TOKEN=$(sed -n 's/^MEMORY_SERVICE_TOKEN=//p' /home/cerebro/stack/elephant/.env)
E=http://127.0.0.1:18790
curl -s -H "Authorization: Bearer $TOKEN" $E/admin/settings/knowledge-media | jq
```

`GET /admin/settings/knowledge-media` returns `{settings: [{name, secret, isSet, value?, source}]}` for every
`KNOWLEDGE_VISION_*` / `KNOWLEDGE_TRANSCRIBE_*` variable. `value` is the effective value (defaults included) for
non-secrets and is **never** returned for secrets (names ending `_API_KEY`). `source` is `stored` (set through this
API), `env` (from `.env`) or `default`; `isSet` is false only for `default`.

`PUT /admin/settings/knowledge-media` with `{"set": {"NAME": "value"}, "unset": ["NAME"]}`:

```bash
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"set":{"KNOWLEDGE_VISION_PROVIDER":"openai","KNOWLEDGE_VISION_BASE_URL":"http://127.0.0.1:8080/v1","KNOWLEDGE_VISION_MODEL":"<model>"}}' \
  $E/admin/settings/knowledge-media | jq
```

- Only names in this group are accepted. A name in both `set` and `unset`, an empty value (use `unset` instead), or
  a combination the full env schema rejects returns **400** and nothing is saved. Send a provider together with
  its credentials in one PUT, since the cross-field rules are checked on the result.
- On success the extraction clients are rebuilt in place, no restart needed; the response has the same shape as
  GET.
- `unset` removes the stored override, so the `.env` value (or the default) applies again.

Resolution order at use time: **stored value -> `.env` -> built-in default.** So a value set through the API
wins over the same variable in `.env`; if editing `.env` seems to have no effect, check `source` in the GET.

## Where it is stored

`<ELEPHANT_STATE_DIR>/settings.enc` (stack: `$STACK_ROOT/data/elephant-state/settings.enc`, directory 0700),
AES-256-GCM. The key is `ELEPHANT_SETTINGS_KEY` (32 bytes, base64 or hex; the stack generates it into
`secrets.env` and renders it into Elephant's `.env`). Without that variable a `settings.key` file (0600) is created
next to the store on first write. `bin/stack backup` saves the state directory as `elephant-state.tar.gz`; it is
only readable with the same key, which `secrets.env` in the same backup holds. If the store cannot be read at
boot, the service starts with env values only and logs `[settings] could not read stored settings; using env only`.

## After enabling a provider

Attachments uploaded while OCR was off are recorded as `skipped` and are not re-read automatically. Re-extract
them with `pnpm backfill:attachment-extraction --yes` from `/home/cerebro/stack/elephant` (dry run without
`--yes`). The backfill builds its own configuration from `.env` plus the stored settings.
