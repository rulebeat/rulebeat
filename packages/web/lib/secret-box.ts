import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readSecretFileTrimmed } from '@/lib/secret-file';

/**
 * Symmetric encryption for the few secrets RuleBeat has to keep — today just the Azure client
 * secret entered in the UI.
 *
 * Storing it in plain text would be below the bar every comparable self-hosted tool sets (n8n
 * encrypts credentials with `N8N_ENCRYPTION_KEY`, Grafana encrypts datasource secrets with its
 * `secret_key`), and the threat it addresses is mundane and real: a SQLite file gets copied into a
 * backup, a support bundle, or a `docker cp`, and the secret goes with it.
 *
 * This does NOT protect against someone who already has the key — the key sits next to the database
 * by default, so an attacker with the volume has both. It protects against the database travelling
 * *without* the volume, which is how these leaks actually happen. A deployment that wants the
 * stronger posture sets RULEBEAT_ENCRYPTION_KEY from a secret store and keeps it out of the volume
 * entirely — which is also why the environment-variable credential path stays first-class.
 */

const KEY_ENV = 'RULEBEAT_ENCRYPTION_KEY';
const KEY_ENV_FILE = 'RULEBEAT_ENCRYPTION_KEY_FILE';
const KEY_FILE = 'encryption.key';
const PREFIX = 'v1';

// Fixed, non-secret salt. The key is either high-entropy already (the generated file) or a value
// the operator chose (the env var); scrypt here is about producing 32 bytes deterministically, not
// about resisting a dictionary attack on a password.
const SALT = Buffer.from('rulebeat-secret-box-v1');

let cachedKey: Buffer | null = null;

/**
 * Where the generated key lives when the operator hasn't supplied one.
 *
 * Deliberately derived from the database path rather than a second independent notion of "the data
 * directory": the key and the ciphertext it opens belong together, and pointing tests at a throwaway
 * database (`RULEBEAT_DB_PATH`) has to move the key with it — otherwise the suite would read, and
 * worse *create*, files in the developer's real data directory. Mirrors lib/db/client.ts.
 */
function keyFilePath(): string {
  const dbPath = process.env['RULEBEAT_DB_PATH'];
  const dir = dbPath && dbPath !== ':memory:' ? dirname(dbPath) : join(process.cwd(), 'data');
  return join(dir, KEY_FILE);
}

function loadOrCreateKeyMaterial(): string {
  // `RULEBEAT_ENCRYPTION_KEY_FILE` (a mounted-secret path) wins over `RULEBEAT_ENCRYPTION_KEY`
  // when both are set, same precedence as `AZURE_CLIENT_SECRET_FILE` over `AZURE_CLIENT_SECRET`.
  // Cached like the env var below (`getKey()`'s `cachedKey`) — a restart is needed to pick up a
  // changed file, unlike the Azure credential's mounted-file reader, which re-reads every call.
  const fromFile = process.env[KEY_ENV_FILE]?.trim();
  if (fromFile) return readSecretFileTrimmed(fromFile, KEY_ENV_FILE);

  const fromEnv = process.env[KEY_ENV]?.trim();
  if (fromEnv) return fromEnv;

  const path = keyFilePath();
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing) return existing;
  }

  // First boot with nothing configured: generate one and persist it, rather than making the
  // operator run a command before the product will start. n8n does the same. The tradeoff is
  // documented in .env.example — lose the volume and stored credentials must be re-entered.
  const generated = randomBytes(32).toString('base64');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${generated}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600); // no-op on Windows; matters on the Linux container's shared volume
  } catch {
    /* best effort — an unreadable-to-others key is a bonus, not a precondition */
  }
  return generated;
}

function getKey(): Buffer {
  if (!cachedKey) cachedKey = scryptSync(loadOrCreateKeyMaterial(), SALT, 32);
  return cachedKey;
}

/** Test seam: forget the cached key so a test can change the key material mid-run. */
export function resetSecretBoxForTests(): void {
  cachedKey = null;
}

/**
 * Encrypts a secret for storage. Output is `v1:<iv>:<authTag>:<ciphertext>`, all base64 — versioned
 * so a future algorithm change can decrypt old values instead of orphaning them.
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12); // 96-bit nonce, the size GCM is specified for
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    PREFIX,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

/**
 * Reverses `encryptSecret`. Returns null rather than throwing when the value can't be opened —
 * the realistic cause is a rotated or lost key, and the product's answer to that is "this credential
 * needs re-entering", not a crashed request.
 */
export function decryptSecret(payload: string): string | null {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;

  try {
    const iv = Buffer.from(parts[1]!, 'base64');
    const authTag = Buffer.from(parts[2]!, 'base64');
    const ciphertext = Buffer.from(parts[3]!, 'base64');

    const decipher = createDecipheriv('aes-256-gcm', getKey(), iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return null; // wrong key, or the ciphertext was tampered with — GCM catches both
  }
}

/** True when `payload` looks like something `decryptSecret` could open, without opening it. */
export function isEncrypted(payload: string): boolean {
  return payload.startsWith(`${PREFIX}:`) && payload.split(':').length === 4;
}

/** Constant-time compare, for the rare places a secret is checked rather than used. */
export function secretsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
