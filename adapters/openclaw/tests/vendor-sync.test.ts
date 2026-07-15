// Drift guard: the vendored client must be byte-identical to
// packages/client/src (modulo the GENERATED header). Regenerate with
// `pnpm sync:vendored-client` when this fails.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const HEADER =
  '// GENERATED — do not edit. Source: packages/client/src.\n// Regenerate with: pnpm sync:vendored-client\n';
const SRC = join(import.meta.dirname, '../../../packages/client/src');
const VENDOR = join(import.meta.dirname, '../vendor');

describe('vendored client stays in sync with packages/client', () => {
  for (const file of ['wire-types.ts', 'client.ts']) {
    test(file, () => {
      const vendored = readFileSync(join(VENDOR, file), 'utf8');
      expect(vendored.startsWith(HEADER)).toBe(true);
      expect(vendored.slice(HEADER.length)).toBe(readFileSync(join(SRC, file), 'utf8'));
    });
  }
});
