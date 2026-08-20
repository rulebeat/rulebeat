/**
 * Two ways to put a sample database through the product's upgrade, plus the scaffolding both need.
 *
 * `upgradeInProcess` calls the migration functions directly and is what the suite uses throughout —
 * it is fast, and it can be pointed at a database left in a half-migrated state.
 *
 * `upgradeViaStartup` spawns a process and imports `lib/db/client.ts` for real. It is slow and
 * clumsy, and it exists for exactly one purpose: proving that the direct calls do the same thing the
 * real startup path does. Without it, every assertion in this suite would rest on an assumption.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase, runMigrations, runSeeds } from '@/lib/db/migrate';
import { buildShape, type BuiltShape, type ShapeName } from './db-shapes';

const WEB_ROOT = resolve(__dirname, '..', '..');
const REPO_ROOT = resolve(WEB_ROOT, '..', '..');
const RUNNER = join(__dirname, 'run-client-upgrade.ts');
// Invoked through node directly rather than `npx tsx`, because the child's working directory has to
// be the sample's own folder (that is what `DATA_DIR` keys off) and npx would then fail to find tsx.
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

export interface Sample {
  /** The sample's own directory. Also the child process's cwd, which is what fixes `DATA_DIR`. */
  dir: string;
  /** Path to the sample database file. */
  file: string;
  /** A `data/` directory of its own, so seeding never reads the developer's real one. */
  dataDir: string;
  built: BuiltShape;
}

/** Builds a sample database of the given shape in its own throwaway directory. */
export function makeSample(shape: ShapeName): Sample {
  const dir = mkdtempSync(join(tmpdir(), `rb-${shape}-`));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const file = join(dir, 'rulebeat.db');
  return { dir, file, dataDir, built: buildShape(shape, file) };
}

/** Opens a sample for inspection. The caller closes it. */
export function open(file: string): Database.Database {
  const sqlite = new Database(file);
  sqlite.pragma('foreign_keys = ON');
  return sqlite;
}

/**
 * Upgrades a sample by calling the migration functions directly — the same two calls, in the same
 * order, that `lib/db/client.ts` makes on startup.
 *
 * Fast enough to use everywhere, and unlike the child-process route it can be pointed at a database
 * deliberately left half-migrated. That it really is equivalent to starting the app is not assumed:
 * `db-migrations-golden.test.ts` asserts the two produce identical databases.
 */
export function upgradeInProcess(sample: Sample): void {
  const sqlite = openDatabase(sample.file);
  try {
    runMigrations(sqlite);
    runSeeds(sqlite, sample.dataDir);
  } finally {
    sqlite.close();
  }
}

/**
 * Drives the real `lib/db/client.ts` startup in a child process. Throws with the child's stderr
 * attached, since a migration failure there is otherwise invisible.
 */
export function upgradeViaStartup(sample: Sample, env: Record<string, string> = {}): void {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, RULEBEAT_DB_PATH: sample.file, ...env };
  // Deleted rather than inherited: a developer's own bootstrap admin must never leak in and change
  // what the sample ends up containing.
  if (!('RULEBEAT_INITIAL_ADMIN' in env)) delete childEnv.RULEBEAT_INITIAL_ADMIN;
  // Also deleted: Vitest sets this in its own process, and `...process.env` above would otherwise
  // carry it into the child. `lib/db/client.ts` reads it to skip the owner-bootstrap file write
  // (unsafe from an ordinary test importing client.ts, whose dataDir it can't control) — but this
  // child's cwd is the sample's own throwaway directory, so the write is safe here and skipping it
  // would make this path diverge from `upgradeInProcess`, which never skips it.
  delete childEnv.VITEST;

  const result = spawnSync(process.execPath, [TSX_CLI, RUNNER], {
    cwd: sample.dir,
    encoding: 'utf8',
    env: childEnv,
  });

  if (result.status !== 0) {
    throw new Error(
      `startup failed for ${sample.file} (exit ${result.status})\n` +
      `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}
