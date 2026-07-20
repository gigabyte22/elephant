// Frontmatter serialization + vault path layout. YAML goes through the
// `yaml` package — hand-rolled escaping of titles is the known footgun.

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { VaultFrontmatter, VaultKind } from './types.ts';

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

// Relative path of an item inside the vault. Knowledge documents without a
// projectId are shared/global; research always carries one.
export function pathFor(kind: VaultKind, id: string, projectId?: string): string {
  const folder = kind === 'research' ? 'research' : 'documents';
  const file = `${sanitizeSegment(id)}.md`;
  return projectId
    ? join('projects', sanitizeSegment(projectId), folder, file)
    : join('shared', folder, file);
}

export function serializeVaultDoc(meta: VaultFrontmatter, body: string): string {
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
export interface NarrativeItem {
  id: string;
  title: string;
  source: string;
  sourceUri?: string;
  contentHash?: string;
  summary: string;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
  projectId?: string;
  userId?: string;
}

export function frontmatterFor(kind: VaultKind, item: NarrativeItem): VaultFrontmatter {
  return {
    okfVersion: 1,
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
    summary: item.summary,
  };
}
