/**
 * `openDatabase()` (lib/db/migrate.ts) must survive losing the rollback-to-WAL conversion race.
 *
 * On a brand-new database file, `PRAGMA journal_mode = WAL` converts the file and needs its
 * exclusive lock. When two fresh processes race that conversion (Next's parallel
 * page-data-collection workers at build time), the loser holds a shared lock the winner needs
 * gone while wanting a write lock the winner already claimed, and SQLite resolves the deadlock by
 * handing the loser SQLITE_BUSY immediately, busy handler bypassed. `busy_timeout` cannot cover
 * it, at any value: measured at 4ms with a 30s timeout armed. That immediate throw was the
 * intermittent `next build` failure in the Docker builder (#51, CI run 32850675658 attempt 1),
 * and openDatabase now retries the pragma instead of surfacing it.
 *
 * The holder is a real second process: better-sqlite3 is synchronous, so the lock has to be
 * released from outside while openDatabase is inside its retry loop. `BEGIN IMMEDIATE` on a
 * rollback-journal connection is exactly the winner-mid-write state the loser collides with.
 */
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../lib/db/migrate';

const HOLDER_SCRIPT = `
  const Database = require(process.env.BS3_PATH);
  const db = new Database(process.env.DB_PATH);
  // A rollback-journal connection on purpose, like a worker that has not converted the file yet.
  db.exec('CREATE TABLE hold_marker (x)');
  db.exec('BEGIN IMMEDIATE');
  db.exec('INSERT INTO hold_marker VALUES (1)');
  require('node:fs').writeFileSync(process.env.SENTINEL_PATH, 'locked');
  setTimeout(() => {
    db.exec('COMMIT');
    db.close();
  }, 1500);
`;

describe('openDatabase · losing the WAL conversion race', () => {
  it('retries past the immediate SQLITE_BUSY instead of throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rb-wal-race-'));
    const dbPath = join(dir, 'rulebeat.db');
    const sentinel = join(dir, 'lock-held');
    const require = createRequire(import.meta.url);

    const holder = spawn(process.execPath, ['-e', HOLDER_SCRIPT], {
      env: {
        ...process.env,
        BS3_PATH: require.resolve('better-sqlite3'),
        DB_PATH: dbPath,
        SENTINEL_PATH: sentinel,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let holderStderr = '';
    holder.stderr.on('data', (chunk) => { holderStderr += chunk; });
    const holderExit = new Promise<number | null>((resolve) => holder.on('close', resolve));

    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(sentinel)) {
        if (Date.now() > deadline) throw new Error(`lock holder never signalled: ${holderStderr}`);
        await new Promise((r) => setTimeout(r, 20));
      }

      // The holder's write lock is live right now, so the WAL conversion inside openDatabase gets
      // its immediate SQLITE_BUSY on the first attempt. Without the retry this line throws in
      // milliseconds; with it, openDatabase keeps retrying until the holder commits (~1.5s) and
      // the conversion goes through.
      const sqlite = openDatabase(dbPath);
      try {
        expect(sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
        // Proof this open really did collide with a live writer rather than winning a vacant
        // file: the holder's transaction committed before we got the lock.
        const row = sqlite.prepare('SELECT count(*) AS n FROM hold_marker').get() as { n: number };
        expect(row.n).toBe(1);
      } finally {
        sqlite.close();
      }

      expect(await holderExit).toBe(0);
    } finally {
      holder.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
