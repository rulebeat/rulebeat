import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readSecretFileTrimmed } from '@/lib/secret-file';

/**
 * The secret Auth.js uses to sign/encrypt session JWTs.
 *
 * `AUTH_SECRET_FILE` (a mounted-secret path — Docker/Kubernetes secrets, the Key Vault CSI driver)
 * wins over `AUTH_SECRET` when both are set, same precedence as `AZURE_CLIENT_SECRET_FILE` over
 * `AZURE_CLIENT_SECRET` in `lib/azure-credential.ts`. Either one wins over generating a value. With
 * nothing set, a value is generated once and persisted next to the database — mirrors
 * `lib/secret-box.ts`'s `loadOrCreateKeyMaterial`, including deriving the path from
 * `RULEBEAT_DB_PATH` so tests never touch the real data dir.
 *
 * Generation uses `flag: 'wx'` (create, fail if it exists) and re-reads on `EEXIST` rather than
 * locking, so two processes racing to generate the file on first boot converge on whichever one
 * wrote first instead of one silently overwriting the other's (already-in-use) secret.
 *
 * Both `AUTH_SECRET` and `AUTH_SECRET_FILE` are cached in memory after the first read (below) —
 * unlike the Azure credential's mounted-file reader, which re-reads on every call. Replacing what
 * a mounted `AUTH_SECRET_FILE` points at, or editing its contents, needs a restart to take effect.
 */

const SECRET_FILE = 'auth.key';

let cachedSecret: string | null = null;

function secretFilePath(): string {
  // Static `process.env.NAME` access, not a dynamic `process.env[var]` lookup: this module gets
  // bundled into proxy.ts's edge/middleware build, and that bundler only inlines env vars it can
  // see referenced literally at build time. A dynamic lookup silently resolves to `undefined`
  // there even with the variable set — which is exactly how this file's twin bug shipped: the
  // proxy generated and cached its own `auth.key`, different from the one the real server
  // processes used, so every session it minted decoded as invalid nowhere but the proxy.
  const dbPath = process.env.RULEBEAT_DB_PATH;
  const dir = dbPath && dbPath !== ':memory:' ? dirname(dbPath) : join(process.cwd(), 'data');
  return join(dir, SECRET_FILE);
}

function generateAndPersist(path: string): string {
  const generated = randomBytes(32).toString('base64');
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, `${generated}\n`, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      // Another process won the race — read what it wrote instead of overwriting it.
      const existing = readFileSync(path, 'utf8').trim();
      if (existing) return existing;
    }
    throw err;
  }
  try {
    chmodSync(path, 0o600); // no-op on Windows; matters on the Linux container's shared volume
  } catch {
    /* best effort */
  }
  return generated;
}

export function getAuthSecret(): string {
  if (cachedSecret) return cachedSecret;

  // Literal `process.env.AUTH_SECRET_FILE` access, not a dynamic lookup — same reason as
  // `secretFilePath()`'s note above: this module is bundled into proxy.ts's edge build, which only
  // inlines env vars referenced statically. A templated/dynamic read here would silently resolve
  // to `undefined` in that bundle and reintroduce the exact split-secret bug this file already
  // shipped once (see tests/unit/auth-config.test.ts's architecture test for this pattern).
  const fromFile = process.env.AUTH_SECRET_FILE?.trim();
  if (fromFile) return (cachedSecret = readSecretFileTrimmed(fromFile, 'AUTH_SECRET_FILE'));

  const fromEnv = process.env.AUTH_SECRET?.trim();
  if (fromEnv) return (cachedSecret = fromEnv);

  const path = secretFilePath();
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing) return (cachedSecret = existing);
  }

  return (cachedSecret = generateAndPersist(path));
}

/** Test seam: forget the cached secret so a test can point at a different data dir mid-run. */
export function resetAuthSecretForTests(): void {
  cachedSecret = null;
}
