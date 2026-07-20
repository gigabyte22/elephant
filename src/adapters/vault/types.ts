// OKF vault — a one-way projection of narrative memory (research, knowledge
// documents) into human-readable markdown files with YAML frontmatter.
// The graph write path stays the single write API; the vault is derived
// output, never a source the service reads back from.

export type VaultKind = 'research' | 'knowledge_document';

export type VaultDeleteReason = 'soft_delete' | 'expired';

export interface VaultFrontmatter {
  okfVersion: 1;
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
  summary?: string;
  // Tombstones only:
  deletedAt?: string;
  deleteReason?: VaultDeleteReason;
}

export interface VaultRef {
  id: string;
  kind: VaultKind;
  projectId?: string;
}

export interface VaultWriter {
  // Materialize (or overwrite) the live markdown file for an item.
  write(meta: VaultFrontmatter, body: string): Promise<void>;
  // Move the live file into _trash/ with deletedAt/deleteReason stamped in
  // the frontmatter; writes a frontmatter-only stub if no live file exists.
  tombstone(ref: VaultRef, at: Date, reason: VaultDeleteReason): Promise<void>;
}
