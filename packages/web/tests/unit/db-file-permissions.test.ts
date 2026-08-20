/**
 * spec 023 · `openDatabase()` restricts the SQLite file and its WAL/SHM sidecars to `0600`.
 *
 * The db file holds every stored secret's ciphertext plus password hashes; group/world-readable
 * permissions on it (the default `umask` on most Linux hosts, e.g. 0644) hand a local read to any
 * other account on the box. Windows has no POSIX mode bits, so this suite is a no-op there — same
 * pattern `auth-secret.test.ts`'s 0600 check already uses.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '@/lib/db/migrate';

let dir: string | null = null;
let sqlite: Database | null = null;

afterEach(() => {
  sqlite?.close();
  sqlite = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe.skipIf(process.platform === 'win32')('openDatabase · file permissions', () => {
  it('sets 0600 on a freshly created database file', () => {
    dir = mkdtempSync(join(tmpdir(), 'rb-db-perms-'));
    const dbPath = join(dir, 'rulebeat.db');
    sqlite = openDatabase(dbPath);

    const mode = statSync(dbPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('sets 0600 on the -wal sidecar once WAL mode creates it', () => {
    dir = mkdtempSync(join(tmpdir(), 'rb-db-perms-'));
    const dbPath = join(dir, 'rulebeat.db');
    sqlite = openDatabase(dbPath);

    const walPath = `${dbPath}-wal`;
    expect(existsSync(walPath)).toBe(true);
    const mode = statSync(walPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('re-tightens permissions on an existing database the next time it is opened', () => {
    dir = mkdtempSync(join(tmpdir(), 'rb-db-perms-'));
    const dbPath = join(dir, 'rulebeat.db');
    sqlite = openDatabase(dbPath);
    sqlite.close();

    // Simulate an upgrade from an older RuleBeat version that never restricted permissions.
    chmodSync(dbPath, 0o644);
    expect(statSync(dbPath).mode & 0o777).toBe(0o644);

    sqlite = openDatabase(dbPath);
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
  });
});
