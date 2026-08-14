// OKF vault — a one-way projection of narrative memory (research, knowledge
// documents) into human-readable markdown files with YAML frontmatter.
// The graph write path stays the single write API; the vault is derived
// output, never a source the service reads back from.

export const VAULT_KINDS = ['research', 'knowledge_document'] as const;
export type VaultKind = (typeof VAULT_KINDS)[number];

// The sync's parse gate: a file counts as OKF output only when its frontmatter
// names a kind we project. Pointed at an unrelated markdown vault every file
// fails here, which is what makes a misconfigured OKF_DIR survivable.
export function isVaultKind(value: unknown): value is VaultKind {
  return typeof value === 'string' && (VAULT_KINDS as readonly string[]).includes(value);
}

// 'orphaned' is the sync reap's reason: the file's node is absent from the
// graph entirely, so Elephant never made a deletion decision about it — the
// projection is simply stale (a wiped test DB, a hard-deleted node, a file
// left behind when a title change moved its slug path).
export type VaultDeleteReason = 'soft_delete' | 'expired' | 'orphaned';

// Bumped to 2 when filenames became title slugs and the redundant `summary`
// left the frontmatter. Written into every new file and compared by the sync
// hash-gate, so a bump is what migrates an existing vault: every file
// disagrees and is rewritten once.
//
// The type stays a union rather than `number` because parseVaultDoc reads v1
// files off disk — narrowing them to the current version would be a lie the
// compiler should not sanction.
export const CURRENT_OKF_VERSION = 2 as const;
export type OkfVersion = 1 | 2;

export interface VaultFrontmatter {
  okfVersion: OkfVersion;
  id: string;
  kind: VaultKind;
  title: string;
  projectId?: string;
  userId?: string;
  source: string;
  sourceUri?: string;
  tags: string[];
  createdAt: string; // ISO
  updatedAt: string; // ISO
  contentHash?: string;
  // Present only when it says something the body doesn't — see vaultDocFor.
  summary?: string;
  summaryTruncated?: boolean;
  // Tombstones only:
  deletedAt?: string;
  deleteReason?: VaultDeleteReason;
}

// Frontmatter of a generated `_index.md`. Deliberately a separate shape rather
// than a third VaultKind: `kind` is threaded through pathFor, VaultRef, the
// writer and the dashboard, all of which are about *nodes*. An index has no
// node, no id, and no audit history.
export interface VaultIndexFrontmatter {
  okfVersion: OkfVersion;
  kind: 'index';
  generated: true;
  projectId?: string;
  counts: { research: number; documents: number };
}

// Identifies the file to tombstone. `title` is optional and only ever an
// optimization: it lets the writer compute the expected path directly instead
// of scanning. The scan is the correctness path, because a title can change
// between the last write and the delete.
export interface VaultRef {
  id: string;
  kind: VaultKind;
  projectId?: string;
  title?: string;
}

export interface VaultWriter {
  // Materialize (or overwrite) the live markdown file for an item, sweeping
  // any stale same-id sibling left by a previous title.
  write(meta: VaultFrontmatter, body: string): Promise<void>;
  // Move the live file into _trash/ with deletedAt/deleteReason stamped in
  // the frontmatter; writes a frontmatter-only stub if no live file exists.
  tombstone(ref: VaultRef, at: Date, reason: VaultDeleteReason): Promise<void>;
  // Tombstone a file the caller has already located and parsed. The sync reap
  // uses this: it knows the exact on-disk path, which for a legacy or stale
  // file is precisely the path `tombstone` would fail to recompute.
  tombstoneFile(relPath: string, at: Date, reason: VaultDeleteReason): Promise<void>;
  // Atomically write arbitrary content at a vault-relative path. Used for the
  // generated `_index.md` notes, which have no node and so no frontmatter of
  // the VaultFrontmatter shape.
  writeRaw(relPath: string, content: string): Promise<void>;
}
