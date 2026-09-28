import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import { dbKind } from '../db/backend';
import { DATA_DIR, resolveSqliteFilePath } from '../db/sqlite-path';
import { getAppVersion } from '../version';
import { DemoConfigError, resolveDemoConfig, type DemoConfig } from './config';
import { DEMO_STAMP_KEY, LEGACY_DEMO_STAMP_KEYS } from './stamp';

// Nothing here may import lib/db/client.ts statically. This module runs from instrumentation.ts
// before anything has opened the database, and its whole job is to decide what file client.ts
// will open: a restored snapshot, or an empty file the generator is about to fill.

/** Where generated Demos are kept, one file per Data set, Seed and release. */
export const DEMO_SNAPSHOT_DIR = join(DATA_DIR, 'demo-snapshots');

/** The snapshot a Demo with this config, on this release, is restored from. */
export function snapshotFileName(config: DemoConfig, version: string): string {
  return `${config.dataSet}-seed-${config.seed.toString(16)}-v${version}.db`;
}

const SQLITE_SIDECARS = ['', '-wal', '-shm'];

function removeSqliteFiles(path: string): void {
  for (const suffix of SQLITE_SIDECARS) rmSync(`${path}${suffix}`, { force: true });
}

/**
 * Throws unless the file at `path` is safe to overwrite: missing, empty, or a database that carries
 * a Demo stamp from this release or an earlier one. This is what stops RULEBEAT_DEMO=1 set on a real
 * install (with RULEBEAT_DB_PATH pointing at its database) from wiping that install on boot.
 */
export function assertReplaceableDemoDatabase(path: string): void {
  if (!existsSync(path) || statSync(path).size === 0) return;

  const keys = [DEMO_STAMP_KEY, ...LEGACY_DEMO_STAMP_KEYS];
  let stamped = false;
  let sqlite: Database.Database | null = null;
  try {
    sqlite = new Database(path, { readonly: true, fileMustExist: true });
    const row = sqlite
      .prepare(`SELECT 1 FROM meta WHERE key IN (${keys.map(() => '?').join(', ')}) LIMIT 1`)
      .get(...keys);
    stamped = row !== undefined;
  } catch {
    // Not a SQLite file, or no meta table: either way nothing proves it is a Demo database.
    stamped = false;
  } finally {
    sqlite?.close();
  }

  if (!stamped) {
    throw new DemoConfigError(
      `${path} is not a Demo database, so the Demo will not overwrite it. ` +
        'Unset RULEBEAT_DEMO to run this install normally, or point the Demo at its own data directory.',
    );
  }
}

/** Replaces the live database with a copy of `snapshot`. */
export function restoreDemoSnapshot(snapshot: string, live: string): void {
  removeSqliteFiles(live);
  copyFileSync(snapshot, live);
}

/**
 * Writes a compact, self-contained copy of an open database to `snapshot`. `VACUUM INTO` reads
 * through the connection, so committed pages still sitting in the WAL are included. It writes to a
 * temporary name first, so a crash mid-write never leaves a truncated file that a later boot would
 * restore as if it were complete.
 */
export function writeDemoSnapshot(sqlite: Database.Database, snapshot: string): void {
  mkdirSync(join(snapshot, '..'), { recursive: true });
  const tmp = `${snapshot}.tmp`;
  rmSync(tmp, { force: true });
  sqlite.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  renameSync(tmp, snapshot);
}

/** Deletes every snapshot in `dir` except `keep`: other Seeds, other Data sets, older releases. */
export function pruneDemoSnapshots(dir: string, keep: string): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name !== keep) rmSync(join(dir, name), { force: true });
  }
}

export type DemoBootResult = 'restored' | 'generated';

/**
 * Gets the demo database ready before the app opens it. Restores the snapshot for this Data set,
 * Seed and release when one exists, which makes every restart a Reset. Otherwise generates the Demo
 * into an empty database and keeps a snapshot of the result. `force` always regenerates.
 *
 * Throws a DemoConfigError, meant to stop the process, when the Demo cannot run: Postgres is
 * configured, the Data set or Seed is invalid, or the file it would replace is not a Demo database.
 */
export async function prepareDemoDatabase(
  opts: { force?: boolean; snapshotDir?: string } = {},
): Promise<DemoBootResult> {
  if (dbKind === 'pg') {
    throw new DemoConfigError(
      'The Demo runs on SQLite only. Unset RULEBEAT_DATABASE_URL, or unset RULEBEAT_DEMO to run this install normally.',
    );
  }

  const config = resolveDemoConfig();
  const live = resolveSqliteFilePath();
  if (live === ':memory:') {
    throw new DemoConfigError('The Demo needs a database file on disk, not :memory:.');
  }
  assertReplaceableDemoDatabase(live);

  const dir = opts.snapshotDir ?? DEMO_SNAPSHOT_DIR;
  const name = snapshotFileName(config, getAppVersion());
  const snapshot = join(dir, name);

  if (!opts.force && existsSync(snapshot)) {
    restoreDemoSnapshot(snapshot, live);
    pruneDemoSnapshots(dir, name);
    return 'restored';
  }

  removeSqliteFiles(live);
  const { runGenerator } = await import('./run');
  await runGenerator(config);

  const { rawSqlite } = await import('../db/client');
  if (!rawSqlite) throw new Error('The demo database was generated but no SQLite handle is open.');
  writeDemoSnapshot(rawSqlite, snapshot);
  pruneDemoSnapshots(dir, name);
  return 'generated';
}
