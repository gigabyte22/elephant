import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

// Encrypted key/value store for settings an admin sets at runtime. AES-256-GCM,
// one file, written via temp-sibling + atomic rename (same pattern as the OKF
// vault writer) at mode 0600. The key is ELEPHANT_SETTINGS_KEY when given,
// otherwise a key file created beside the store on first write. A key file next
// to the ciphertext only protects against the file leaking on its own (a backup,
// a stray copy); set ELEPHANT_SETTINGS_KEY from a secret manager to do better.

export interface SettingsStore {
  load(): Record<string, string>;
  save(values: Record<string, string>): void;
}

const STORE_FILE = 'settings.enc';
const KEY_FILE = 'settings.key';
const KEY_BYTES = 32;

function parseKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const key = /^[0-9a-f]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error('ELEPHANT_SETTINGS_KEY must be 32 bytes, base64 or hex encoded');
  }
  return key;
}

function writeAtomic(path: string, data: string | Buffer): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  const fd = openSync(tmp, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function createSettingsStore(dir: string, keyFromEnv?: string): SettingsStore {
  const storePath = join(dir, STORE_FILE);
  const keyPath = join(dir, KEY_FILE);

  function readKey(): Buffer | null {
    if (keyFromEnv) return parseKey(keyFromEnv);
    if (existsSync(keyPath)) return parseKey(readFileSync(keyPath, 'utf8'));
    return null;
  }

  return {
    load() {
      if (!existsSync(storePath)) return {};
      const key = readKey();
      if (!key) throw new Error(`${storePath} exists but no key is available to decrypt it`);
      const file = JSON.parse(readFileSync(storePath, 'utf8')) as {
        iv: string;
        tag: string;
        data: string;
      };
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(file.data, 'base64')),
        decipher.final(),
      ]);
      return JSON.parse(plain.toString('utf8')) as Record<string, string>;
    },

    save(values) {
      let key = readKey();
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (!key) {
        key = randomBytes(KEY_BYTES);
        writeAtomic(keyPath, key.toString('base64'));
      }
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(JSON.stringify(values), 'utf8'), cipher.final()]);
      writeAtomic(
        storePath,
        JSON.stringify({
          v: 1,
          iv: iv.toString('base64'),
          tag: cipher.getAuthTag().toString('base64'),
          data: data.toString('base64'),
        }),
      );
    },
  };
}
