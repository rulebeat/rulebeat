/**
 * `lib/auth-secret.ts` — the value Auth.js signs/encrypts session JWTs with.
 *
 * `tests/setup.ts` pins `AUTH_SECRET` for every other suite specifically so this generation path
 * never runs during the normal test run and never writes a file. This suite is the one place that
 * deliberately unsets it, always inside its own throwaway directory (via `RULEBEAT_DB_PATH`),
 * mirroring how `lib/secret-box.ts` derives its key file location.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAuthSecret, resetAuthSecretForTests } from '@/lib/auth-secret';

const ORIGINAL_AUTH_SECRET = process.env.AUTH_SECRET;
const ORIGINAL_AUTH_SECRET_FILE = process.env.AUTH_SECRET_FILE;
const ORIGINAL_DB_PATH = process.env.RULEBEAT_DB_PATH;

function withThrowawayDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'rb-auth-secret-'));
  try {
    process.env.RULEBEAT_DB_PATH = join(dir, 'rulebeat.db');
    delete process.env.AUTH_SECRET;
    delete process.env.AUTH_SECRET_FILE;
    resetAuthSecretForTests();
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Writes `contents` to a throwaway file and returns its path — stands in for a mounted secret. */
function secretFile(dir: string, contents: string): string {
  const path = join(dir, 'auth_secret_mounted');
  writeFileSync(path, contents);
  return path;
}

afterEach(async () => {
  if (ORIGINAL_AUTH_SECRET === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = ORIGINAL_AUTH_SECRET;
  if (ORIGINAL_AUTH_SECRET_FILE === undefined) delete process.env.AUTH_SECRET_FILE;
  else process.env.AUTH_SECRET_FILE = ORIGINAL_AUTH_SECRET_FILE;
  if (ORIGINAL_DB_PATH === undefined) delete process.env.RULEBEAT_DB_PATH;
  else process.env.RULEBEAT_DB_PATH = ORIGINAL_DB_PATH;
  resetAuthSecretForTests();
});

describe('getAuthSecret', () => {
  it('env wins over any file', async () => {
    withThrowawayDir(dir => {
      process.env.AUTH_SECRET = 'the-configured-secret';
      expect(getAuthSecret()).toBe('the-configured-secret');
      expect(existsSync(join(dir, 'auth.key'))).toBe(false);
    });
  });

  it('with no env set, generates and persists a key file at 0600', async () => {
    withThrowawayDir(dir => {
      const secret = getAuthSecret();
      expect(secret.length).toBeGreaterThan(20);

      const path = join(dir, 'auth.key');
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, 'utf8').trim()).toBe(secret);

      if (process.platform !== 'win32') {
        const mode = statSync(path).mode & 0o777;
        expect(mode).toBe(0o600);
      }
    });
  });

  it('is stable across repeated calls in the same process', async () => {
    withThrowawayDir(() => {
      const first = getAuthSecret();
      const second = getAuthSecret();
      expect(second).toBe(first);
    });
  });

  it('reads a pre-existing file rather than overwriting it', async () => {
    withThrowawayDir(() => {
      const first = getAuthSecret();
      resetAuthSecretForTests(); // simulate a fresh process re-reading the same data dir
      const second = getAuthSecret();
      expect(second).toBe(first);
    });
  });

  // The genuine race this file's `flag: 'wx'` + EEXIST fallback exists for is two real OS
  // processes hitting first boot at once — not representable in a single synchronous test. What's
  // covered above (a file that already exists is read, never overwritten) is the same guarantee
  // observed from the other side of that race.

  // spec 023: AUTH_SECRET_FILE — a mounted-secret path, same precedence as AZURE_CLIENT_SECRET_FILE
  // in lib/azure-credential.ts.
  it('AUTH_SECRET_FILE wins over a simultaneously-set AUTH_SECRET', async () => {
    withThrowawayDir(dir => {
      const path = secretFile(dir, 'from-the-mounted-file\n');
      process.env.AUTH_SECRET_FILE = path;
      process.env.AUTH_SECRET = 'the-configured-secret';
      expect(getAuthSecret()).toBe('from-the-mounted-file');
    });
  });

  it('AUTH_SECRET_FILE alone is read, trimmed, and used — never falls through to generation', async () => {
    withThrowawayDir(dir => {
      const path = secretFile(dir, '  from-the-mounted-file  \n');
      process.env.AUTH_SECRET_FILE = path;
      expect(getAuthSecret()).toBe('from-the-mounted-file');
      expect(existsSync(join(dir, 'auth.key'))).toBe(false);
    });
  });

  it('an empty or whitespace-only AUTH_SECRET_FILE throws', async () => {
    withThrowawayDir(dir => {
      const path = secretFile(dir, '   \n');
      process.env.AUTH_SECRET_FILE = path;
      expect(() => getAuthSecret()).toThrow(/AUTH_SECRET_FILE/);
    });
  });
});
