// Frontmatter serialization + vault path layout. YAML goes through the
// `yaml` package — hand-rolled escaping of titles is the known footgun.

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  CURRENT_OKF_VERSION,
  type VaultFrontmatter,
  type VaultIndexFrontmatter,
  type VaultKind,
} from './types.ts';

// Reduce an arbitrary string (projectId is any non-empty string) to a safe
// path segment. Whenever sanitization changes anything — including dot-only
// segments like '..' that are traversal in disguise — a short hash of the
// original is appended so two inputs that clean to the same text still get
// distinct directories.
export function sanitizeSegment(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '_');
  const dotOnly = /^\.{1,2}$/.test(cleaned);
  if (cleaned === raw && !dotOnly && cleaned.length > 0) return cleaned;
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 8);
  const stem = dotOnly || cleaned.length === 0 ? 'x' : cleaned.replace(/^\.+/, '');
  return `${stem}-${hash}`;
}

const SLUG_MAX = 72;

// Filename-friendly form of a title. Unlike sanitizeSegment — which must keep
// distinct inputs distinct, because a projectId is an identity and a
// collision would merge two projects' directories — a slug is free to be
// lossy: pathFor keeps identity in the id suffix, so the slug only has to be
// readable and safe. Returns '' when nothing survives (an all-emoji title).
//
// Output alphabet is [a-z0-9-] with runs collapsed, which is what lets '--'
// serve as an unambiguous separator and guarantees no traversal surface, no
// leading '.' or '_', and no collision with _index.md or _trash.
export function slugify(title: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // drop the combining marks NFKD split off
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (base.length <= SLUG_MAX) return base;
  // Cut back to a word boundary so a truncated slug still reads as words.
  const cut = base.slice(0, SLUG_MAX);
  const lastHyphen = cut.lastIndexOf('-');
  return (lastHyphen > 0 ? cut.slice(0, lastHyphen) : cut).replace(/-+$/, '');
}

export interface VaultPathRef {
  kind: VaultKind;
  id: string;
  projectId?: string;
  title?: string;
}

// The vault's top-level bucket for a scope: one directory per project, plus
// `shared` for unscoped knowledge documents. Both pathFor and the `_index.md`
// generator resolve it here, so a project's index cannot end up beside a
// different directory than the documents it lists.
export function bucketDirFor(projectId: string | undefined): string {
  return projectId ? join('projects', sanitizeSegment(projectId)) : 'shared';
}

// Relative path of an item inside the vault. Knowledge documents without a
// projectId are shared/global; research always carries one.
//
// The `--{id}` suffix is load-bearing. Titles are neither unique (twenty
// title/directory pairs collide in the live vault) nor immutable, so a slug
// alone would let one document silently overwrite another and would move
// whenever a title was edited. Identity stays in the id; the slug is what
// makes the vault browsable.
//
// Every live file ends in `--{id}.md`, titled or not — an untitled ref slugs
// to 'untitled' rather than dropping the suffix. That uniformity is what lets
// the writer and the reap find a file by id with one `endsWith` and no
// special cases.
export function pathFor(ref: VaultPathRef): string {
  const folder = ref.kind === 'research' ? 'research' : 'documents';
  const slug = ref.title === undefined ? '' : slugify(ref.title);
  const file = `${slug === '' ? 'untitled' : slug}--${sanitizeSegment(ref.id)}.md`;
  return join(bucketDirFor(ref.projectId), folder, file);
}

// Does `filename` name a vault file for `id`? Matches the v2 layout
// ({slug}--{id}.md) and also the v1 bare-id layout, so a lookup by id still
// finds a not-yet-migrated file — otherwise deleting a document during the
// migration window would leave its file live and write an empty tombstone.
export function matchesId(filename: string, id: string): boolean {
  const safeId = sanitizeSegment(id);
  return filename === `${safeId}.md` || filename.endsWith(`--${safeId}.md`);
}

export function serializeVaultDoc(
  meta: VaultFrontmatter | VaultIndexFrontmatter,
  body: string,
): string {
  // Drop undefined fields so the frontmatter stays clean.
  const clean = Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined));
  return `---\n${stringifyYaml(clean)}---\n\n${body}\n`;
}

export function parseVaultDoc(text: string): { meta: VaultFrontmatter; body: string } | null {
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---\n', 4);
  if (end < 0) return null;
  let meta: VaultFrontmatter;
  try {
    meta = parseYaml(text.slice(4, end + 1)) as VaultFrontmatter;
  } catch {
    return null;
  }
  // Undo the blank line + trailing newline serializeVaultDoc adds, so
  // serialize → parse round-trips the body byte-identically.
  const body = text
    .slice(end + 5)
    .replace(/^\n/, '')
    .replace(/\n$/, '');
  return { meta, body };
}

// Shared shape of Research / KnowledgeDocument that maps onto frontmatter.
// `content` is absent from frontmatter but belongs here: it is what bodyFor
// projects, and every caller of vaultDocFor also needs a body.
export interface NarrativeItem {
  id: string;
  title: string;
  source: string;
  sourceUri?: string;
  content?: string;
  contentHash?: string;
  summary: string;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
  projectId?: string;
  userId?: string;
}

// The one answer to "what is the markdown body of a narrative node". Rows
// created before content retention (M1) only have a summary, so say so
// explicitly rather than silently presenting a summary as if it were the body.
// Every projection — live write, sync repair, and the dashboard's read-only
// markdown view — goes through here so they cannot drift apart.
export function bodyFor(item: Pick<NarrativeItem, 'content' | 'summary'>): string {
  if (item.content !== undefined && item.content !== '') return item.content;
  return `${item.summary}\n\n> body not retained (pre-OKF record; only the summary survives)`;
}

// Frontmatter is metadata, so a summary earns its place only when it says
// something the body does not. Below SUMMARY_THRESHOLD_TOKENS the ingest path
// stores the content verbatim as its own summary (resolveSummary in
// KnowledgeIngestionService / ResearchService), and bodyFor's pre-OKF branch
// opens with the summary too — so without this predicate most files carry the
// whole document twice. It held for 522 of the 567 files in the live vault.
const SUMMARY_MAX_CHARS = 1000;

function clipSummary(text: string): { text: string; truncated: boolean } {
  if (text.length <= SUMMARY_MAX_CHARS) return { text, truncated: false };
  const cut = text.slice(0, SUMMARY_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  const kept = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  return { text: `${kept.trimEnd()}…`, truncated: true };
}

function summaryFields(
  summary: string,
  body: string,
): Pick<VaultFrontmatter, 'summary' | 'summaryTruncated'> {
  const trimmed = summary.trim();
  // Order matters: an empty summary must short-circuit, because
  // `body.startsWith('')` is vacuously true and reaching the same answer
  // through the duplication rule would read as an accident.
  if (trimmed === '') return {};
  if (body.trimStart().startsWith(trimmed)) return {};
  const { text, truncated } = clipSummary(trimmed);
  return { summary: text, ...(truncated && { summaryTruncated: true }) };
}

// The single renderer for a narrative node's markdown. Body first, because
// the frontmatter's summary predicate is a question about the body.
//
// Every projection goes through this one function — live write, sync, and the
// dashboard's "open as markdown" — which is what makes the integration test
// asserting byte-equality between the endpoint and the file on disk a real
// guard rather than a test of two parallel implementations.
export function vaultDocFor(
  kind: VaultKind,
  item: NarrativeItem,
): { meta: VaultFrontmatter; body: string } {
  const body = bodyFor(item);
  const meta: VaultFrontmatter = {
    okfVersion: CURRENT_OKF_VERSION,
    id: item.id,
    kind,
    title: item.title,
    ...(item.projectId !== undefined && { projectId: item.projectId }),
    ...(item.userId !== undefined && { userId: item.userId }),
    source: item.source,
    ...(item.sourceUri !== undefined && { sourceUri: item.sourceUri }),
    tags: item.tags,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
    ...(item.contentHash !== undefined && { contentHash: item.contentHash }),
    ...summaryFields(item.summary, body),
  };
  return { meta, body };
}
