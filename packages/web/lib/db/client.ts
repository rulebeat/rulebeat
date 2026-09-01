import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import * as schema from './schema';
import * as pgSchema from './schema.pg';
import { openDatabase, runMigrations, runSeeds } from './migrate';
import { isDemoEnv } from '../demo-env';
import { databaseUrl, dbKind } from './backend';
import { bootstrapPg } from './pg/bootstrap';

// turbopackIgnore: this directory holds runtime-generated state (the SQLite db, schema cache),
// not code — without the hint, Next's build-time file tracer can't prove that and falls back to
// tracing (and, under `output: 'standalone'`, physically copying) the entire project tree, which
// swept a live local dev database into a build output once (P2-10).
const DATA_DIR = join(/* turbopackIgnore: true */ process.cwd(), 'data');

// Needed in both backends: key files (auth.key/encryption.key) and the schema cache live here
// regardless of where the database itself is.
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

let sqliteHandle: ReturnType<typeof openDatabase> | null = null;
let sqliteDrizzle: BetterSQLite3Database<typeof schema> | null = null;
let pgDrizzle: NodePgDatabase<typeof pgSchema> | null = null;
let ready: Promise<void> = Promise.resolve();

if (dbKind === 'pg') {
  // Postgres mode (issue #73): RULEBEAT_DATABASE_URL is set. One pool for the process; Drizzle's
  // node-postgres dialect on top of it. Schema bootstrap is async and this module must not use
  // top-level await (route bundles load it synchronously), so the promise is exported as
  // `dbReady` and every query path in exec.ts awaits it before touching the database. A failed
  // bootstrap therefore rejects the first query loudly instead of racing it.
  const pool = new Pool({ connectionString: databaseUrl! });
  pgDrizzle = drizzlePg(pool, { schema: pgSchema });
  ready = bootstrapPg(pgDrizzle);
} else {
  // SQLite mode: the default, byte-identical to the behaviour before Postgres support existed.

  // The database file is overridable purely so the test suite can point at a throwaway file (or
  // `:memory:`) instead of the real one — this module opens its connection at import time, so a test
  // importing any repository would otherwise read and write the developer's own database. Nothing in
  // the product sets this: unset means the normal `data/rulebeat.db`, which is what every install
  // uses. DATA_DIR itself is deliberately *not* overridable — the legacy-JSON migrations and pack
  // seeding below read from it, and pointing those elsewhere would silently skip both.
  //
  // `RULEBEAT_DEMO=1` takes the same normal-install branch to a different file, `demo.db`, rather
  // than `rulebeat.db` — this is the first of demo mode's two gates (see lib/demo.ts for the second).
  // It is checked ahead of RULEBEAT_DB_PATH's test override so a test that explicitly sets both still
  // gets its own throwaway file, never a stray demo.db. Routing to a distinct file, rather than a flag
  // read at query time, is what makes it structurally impossible for demo mode to read or write the
  // real tenant's data: the process never even opens rulebeat.db.
  const DEFAULT_DB_NAME = isDemoEnv() ? 'demo.db' : 'rulebeat.db';
  const DB_PATH = process.env.RULEBEAT_DB_PATH ?? join(DATA_DIR, DEFAULT_DB_NAME);

  if (DB_PATH !== ':memory:') {
    const dbDir = dirname(DB_PATH);
    if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
  }

  sqliteHandle = openDatabase(DB_PATH);

  // Bring the file up to the current schema, then seed built-in content. Both live in ./migrate so
  // they can be run against a database other than this one — see tests/unit/db-migrations*.test.ts.
  // The order matters and is asserted by those tests: nothing may be seeded into a schema that has
  // not been migrated first.
  runMigrations(sqliteHandle);

  sqliteDrizzle = drizzle(sqliteHandle, { schema });

  // See runSeeds' own doc comment: this is the one call site that can't point dataDir at a
  // throwaway directory, so it's the one that opts out of the owner-bootstrap file write under Vitest
  // (which sets this env var itself — nothing in the product does).
  runSeeds(sqliteHandle, DATA_DIR, { skipOwnerBootstrap: !!process.env.VITEST });
}

/** Raw better-sqlite3 connection. Null in Postgres mode; only exec.ts's transaction helper and
 *  SQLite-only code (migrate/seed tooling, tests) may touch it. */
export const rawSqlite = sqliteHandle;

/** The Drizzle node-postgres instance. Null in SQLite mode; only exec.ts may touch it. */
export const pgDb = pgDrizzle;

/** Resolves when the active backend is ready for queries. SQLite is ready synchronously at import
 *  (migrations and seeds above have already run); Postgres resolves after `bootstrapPg`. exec.ts
 *  awaits this before every query, so no caller may race an unfinished bootstrap. */
export const dbReady = ready;

/**
 * The one `db` handle repositories build queries on.
 *
 * Statically it is always the better-sqlite3 Drizzle type, matching the SQLite-twin tables
 * exported by `tables.ts`; at runtime it is whichever dialect's instance this process opened.
 * The cast is the composition-root half of the dual-backend design described in `tables.ts`,
 * and it is why terminators (`.all()`/`.get()`/`.run()` vs awaiting) must only ever be applied
 * by `exec.ts`, never called directly in a ported repository.
 */
export const db: BetterSQLite3Database<typeof schema> = dbKind === 'pg'
  ? (pgDrizzle as unknown as BetterSQLite3Database<typeof schema>)
  : sqliteDrizzle!;
