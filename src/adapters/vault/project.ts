// Vault projection policy shared by the narrative services (research,
// knowledge). Projection runs AFTER the graph transaction commits and is
// log-and-continue: failing the request post-commit would report a false
// failure, and the vault sync (./sync.ts) is the repair path. When no vault
// is configured these are no-ops.

import { type NarrativeItem, vaultDocFor } from './frontmatter.ts';
import type { VaultKind, VaultWriter } from './types.ts';

export async function projectToVault(
  vault: VaultWriter | undefined,
  kind: VaultKind,
  item: NarrativeItem,
): Promise<void> {
  if (!vault) return;
  try {
    const { meta, body } = vaultDocFor(kind, item);
    await vault.write(meta, body);
  } catch (err) {
    console.error('[okf] vault write failed', { id: item.id, err });
  }
}

// `title` is optional because the caller may not have it, but both service
// call sites pass their full record, so in practice it is always present and
// the writer gets its direct-hit path.
export async function tombstoneInVault(
  vault: VaultWriter | undefined,
  kind: VaultKind,
  item: { id: string; projectId?: string; title?: string },
  at: Date,
): Promise<void> {
  if (!vault) return;
  try {
    await vault.tombstone(
      { id: item.id, kind, projectId: item.projectId, title: item.title },
      at,
      'soft_delete',
    );
  } catch (err) {
    console.error('[okf] vault tombstone failed', { id: item.id, err });
  }
}
