/**
 * `openDatabase()` (lib/db/migrate.ts) forces the WAL sidecar into existence on a brand-new
 * database file with a throwaway "create then drop" table. Found by hand: Next's production build
 * opens the database from several parallel workers at once (page-data collection), and when two of
 * them race this on the same still-empty file, one can drop the table a moment before the other
 * gets to — an unconditional `DROP TABLE` then throws "no such table" instead of no-op'ing.
 * Reproduced here by driving two raw connections to the same fresh file through the exact
 * interleaving that triggers it, without relying on real OS-level concurrency.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database, { type Database as DatabaseType } from 'better-sqlite3';

let dir: string | null = null;
let a: DatabaseType | null = null;
let b: DatabaseType | null = null;

afterEach(() => {
  a?.close();
  b?.close();
  a = null;
  b = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('WAL-bootstrap throwaway table · concurrent openers', () => {
  it('does not throw when two connections interleave the create/drop on the same fresh file', () => {
    dir = mkdtempSync(join(tmpdir(), 'rb-wal-bootstrap-'));
    const dbPath = join(dir, 'rulebeat.db');

    a = new Database(dbPath);
    b = new Database(dbPath);

    // Both processes see the table missing and both create it, exactly like two openDatabase()
    // calls racing on a file neither has seen before.
    a.exec('CREATE TABLE IF NOT EXISTS __rulebeat_wal_bootstrap (x);');
    b.exec('CREATE TABLE IF NOT EXISTS __rulebeat_wal_bootstrap (x);');

    a.exec('DROP TABLE IF EXISTS __rulebeat_wal_bootstrap;');
    expect(() => b!.exec('DROP TABLE IF EXISTS __rulebeat_wal_bootstrap;')).not.toThrow();
  });
});
