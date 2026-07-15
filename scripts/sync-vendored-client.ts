// Copies packages/client/src into adapters/openclaw/vendor with a GENERATED
// header. The OpenClaw plugin must install standalone (npm / ClawHub / local
// path), so it cannot carry a workspace: dependency — it vendors the client
// instead. adapters/openclaw/tests/vendor-sync.test.ts fails when the copies
// drift from the source.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'packages/client/src');
const DEST = join(ROOT, 'adapters/openclaw/vendor');

export const VENDORED_FILES = ['wire-types.ts', 'client.ts'];
export const HEADER =
  '// GENERATED — do not edit. Source: packages/client/src.\n// Regenerate with: pnpm sync:vendored-client\n';

export function sync(): void {
  mkdirSync(DEST, { recursive: true });
  for (const file of VENDORED_FILES) {
    const body = readFileSync(join(SRC, file), 'utf8');
    writeFileSync(join(DEST, file), HEADER + body);
    console.log(`vendored ${file}`);
  }
}

if (process.argv[1]?.endsWith('sync-vendored-client.ts')) {
  sync();
}
