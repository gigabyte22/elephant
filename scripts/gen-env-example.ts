// Generates .env.example from the env schema in src/config/env.ts, so the
// example can never miss a variable the service reads.
//
//   pnpm gen:env-example           # rewrite .env.example
//   pnpm gen:env-example --check   # exit 1 if it is out of date (CI)
//
// Documentation comes from the source: the `//` comment lines directly above a
// key become its `#` comment, and a `// --- Title ---` line opens a section.
// Values: a required key is left blank to fill in, a key with a default is
// shown commented out at that default, and an optional key is commented out
// blank.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ZodTypeAny } from 'zod';
import { EnvSchema } from '../src/config/env.ts';

const root = resolve(import.meta.dirname, '..');
const sourcePath = resolve(root, 'src/config/env.ts');
const examplePath = resolve(root, '.env.example');

// Comment lines above each key in the EnvSchema object literal, in source order.
function commentsByKey(source: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let pending: string[] = [];
  for (const line of source.split('\n')) {
    const comment = /^ {4}\/\/ ?(.*)$/.exec(line);
    if (comment) {
      pending.push(comment[1] ?? '');
      continue;
    }
    const key = /^ {4}([A-Z][A-Z0-9_]*):/.exec(line);
    if (key?.[1]) out.set(key[1], pending);
    pending = [];
  }
  return out;
}

function valueLine(key: string, field: ZodTypeAny): string {
  const parsed = field.safeParse(undefined);
  if (!parsed.success) return `${key}=`;
  if (parsed.data === undefined) return `# ${key}=`;
  return `# ${key}=${String(parsed.data)}`;
}

function renderEnvExample(): string {
  const comments = commentsByKey(readFileSync(sourcePath, 'utf8'));
  const lines = [
    '# Generated from src/config/env.ts by scripts/gen-env-example.ts. Do not',
    '# edit by hand: change the schema or its comments, then run',
    '# `pnpm gen:env-example`.',
    '#',
    '# Blank values are required. Commented-out values show the default.',
  ];
  for (const [key, field] of Object.entries(EnvSchema.innerType().shape)) {
    const docs = comments.get(key) ?? [];
    if (docs.length > 0) lines.push('');
    for (const text of docs) {
      const section = /^--- (.+) ---$/.exec(text);
      if (section) lines.push(`# --- ${section[1]} ---`);
      else lines.push(text ? `# ${text}` : '#');
    }
    lines.push(valueLine(key, field as ZodTypeAny));
  }
  return `${lines.join('\n')}\n`;
}

const expected = renderEnvExample();
if (process.argv.includes('--check')) {
  const current = existsSync(examplePath) ? readFileSync(examplePath, 'utf8') : '';
  if (current !== expected) {
    console.error(
      '.env.example is out of date with src/config/env.ts. Run `pnpm gen:env-example`.',
    );
    process.exit(1);
  }
  console.log('.env.example is up to date');
} else {
  writeFileSync(examplePath, expected);
  console.log(`wrote ${examplePath}`);
}
