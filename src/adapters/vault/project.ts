// Vault projection policy shared by the narrative services (research,
// knowledge). Projection runs AFTER the graph transaction commits and is
// log-and-continue: failing the request post-commit would report a false
// failure, and scripts/okf-sync.ts is the repair path. When no vault is
// configured these are no-ops.

import { type NarrativeItem, frontmatterFor } from './frontmatter.ts';
import type { VaultKind, VaultWriter } from './types.ts';

export async function projectToVault(
  vault: VaultWriter | undefined,
  kind: VaultKind,
  item: NarrativeItem & { content?: string },
): Promise<void> {
  if (!vault) return;
  try {
    await vault.write(frontmatterFor(kind, item), item.content ?? item.summary);
  } catch (err) {
    console.error('[okf] vault write failed', { id: item.id, err });
  }
}

export async function tombstoneInVault(
  vault: VaultWriter | undefined,
  kind: VaultKind,
  item: { id: string; projectId?: string },
  at: Date,
): Promise<void> {
  if (!vault) return;
  try {
    await vault.tombstone({ id: item.id, kind, projectId: item.projectId }, at, 'soft_delete');
  } catch (err) {
    console.error('[okf] vault tombstone failed', { id: item.id, err });
  }
}
