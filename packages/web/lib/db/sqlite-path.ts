import { join } from 'path';
import { isDemoEnv } from '../demo-env';

// turbopackIgnore: this directory holds runtime-generated state (the SQLite db, schema cache),
// not code. Without the hint, Next's build-time file tracer can't prove that and falls back to
// tracing (and, under `output: 'standalone'`, physically copying) the entire project tree, which
// swept a live local dev database into a build output once (P2-10).
export const DATA_DIR = join(/* turbopackIgnore: true */ process.cwd(), 'data');

/**
 * The SQLite file this process opens. Its own module, free of any database import, so the Demo's
 * boot step (lib/demo/boot.ts) can prepare the file before lib/db/client.ts opens it.
 *
 * `RULEBEAT_DB_PATH` exists purely so the test suite can point at a throwaway file (or `:memory:`)
 * instead of the real one; nothing in the product sets it. DATA_DIR itself is deliberately not
 * overridable: the legacy-JSON migrations and pack seeding read from it, and pointing those
 * elsewhere would silently skip both.
 *
 * `RULEBEAT_DEMO=1` routes a normal install to `demo.db` rather than `rulebeat.db`, the first of
 * the Demo's two gates (lib/demo/index.ts has the second). The test override still wins, so a test
 * that sets both gets its own throwaway file, never a stray demo.db. Routing to a distinct file
 * rather than a flag read at query time is what makes it structurally impossible for a Demo to
 * read or write a real tenant's data: the process never opens rulebeat.db.
 */
export function resolveSqliteFilePath(): string {
  return process.env.RULEBEAT_DB_PATH ?? join(DATA_DIR, isDemoEnv() ? 'demo.db' : 'rulebeat.db');
}
