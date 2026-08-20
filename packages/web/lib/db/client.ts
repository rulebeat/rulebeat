import { drizzle } from 'drizzle-orm/better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import * as schema from './schema';
import { openDatabase, runMigrations, runSeeds } from './migrate';
import { isDemoEnv } from '../demo-env';

// turbopackIgnore: this directory holds runtime-generated state (the SQLite db, schema cache),
// not code — without the hint, Next's build-time file tracer can't prove that and falls back to
// tracing (and, under `output: 'standalone'`, physically copying) the entire project tree, which
// swept a live local dev database into a build output once (P2-10).
const DATA_DIR = join(/* turbopackIgnore: true */ process.cwd(), 'data');

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

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
if (DB_PATH !== ':memory:') {
  const dbDir = dirname(DB_PATH);
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
}

const sqlite = openDatabase(DB_PATH);

// Bring the file up to the current schema, then seed built-in content. Both live in ./migrate so
// they can be run against a database other than this one — see tests/unit/db-migrations*.test.ts.
// The order matters and is asserted by those tests: nothing may be seeded into a schema that has
// not been migrated first.
runMigrations(sqlite);

export const db = drizzle(sqlite, { schema });

// See runSeeds' own doc comment: this is the one call site that can't point dataDir at a
// throwaway directory, so it's the one that opts out of the owner-bootstrap file write under Vitest
// (which sets this env var itself — nothing in the product does).
runSeeds(sqlite, DATA_DIR, { skipOwnerBootstrap: !!process.env.VITEST });
