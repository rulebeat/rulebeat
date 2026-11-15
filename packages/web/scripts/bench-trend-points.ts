// Benchmarks the trend point refresh and the dashboard reads that sit beside it (ADR 0013)
// Run: npm run bench:trend-points --workspace=packages/web -- --backend sqlite
//      npm run bench:trend-points --workspace=packages/web -- --backend postgres --pg-url postgres://user:pass@localhost:5432/scratch
//
//   --backend NAME        sqlite (default) or postgres
//   --pg-url URL          the Postgres database to use (or RULEBEAT_BENCH_PG_URL). Use a scratch database: the
//                         bench writes rules, findings and trend points into it and refuses one that already holds findings or trend points
//   --subscriptions N     subscriptions in the management group tree (default 2000)
//   --categories N        categories (default 30)
//   --findings N          findings the scans save (default 50000)
//   --rules-per-category N  rules in each category (default 8)
//   --seed N              the dataset's seed; the same seed gives the same data (default 1)
//   --warm-runs N         runs after the cold one, the median of which is reported (default 3)
//   --json                print the result as JSON instead of a table
//
// On SQLite it always works in a fresh file in the temp directory, which it deletes at the end, and clears
// every database variable first so a developer's own Postgres or demo is never touched. Postgres is reached
// only through the URL given to this script.
//
// No static imports of anything under lib/ here: RULEBEAT_DB_PATH and RULEBEAT_DATABASE_URL must be set
// before lib/db/client.ts opens its connection, and a static import is hoisted above that assignment.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A fresh database seeds a first-run owner account and writes its password into data/, which is the
// one thing here that lands outside the temp directory. Remove it afterwards unless it was already there.
const passwordFile = join(process.cwd(), 'data', 'initial-password.txt');
const hadPasswordFile = existsSync(passwordFile);
const tempDir = mkdtempSync(join(tmpdir(), 'rulebeat-bench-'));

function stringFlag(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

function numberFlag(args: string[], flag: string, fallback: number): number {
  const raw = stringFlag(args, flag);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${flag} needs a whole number, not "${raw}".`);
  return value;
}

const args = process.argv.slice(2);
const backend = stringFlag(args, '--backend') ?? 'sqlite';
if (backend !== 'sqlite' && backend !== 'postgres') throw new Error(`--backend is "${backend}": use sqlite or postgres.`);
const pgUrl = stringFlag(args, '--pg-url') ?? process.env.RULEBEAT_BENCH_PG_URL;
if (backend === 'postgres' && !pgUrl) throw new Error('--backend postgres needs --pg-url (or RULEBEAT_BENCH_PG_URL): a scratch database to write into.');

for (const name of ['RULEBEAT_DATABASE_URL', 'RULEBEAT_DATABASE_URL_FILE', 'RULEBEAT_DATABASE_BACKEND', 'RULEBEAT_DEMO']) delete process.env[name];
process.env.RULEBEAT_DB_PATH = join(tempDir, 'bench.db');
if (backend === 'postgres') {
  process.env.RULEBEAT_DATABASE_URL = pgUrl;
  process.env.RULEBEAT_DATABASE_BACKEND = 'postgres';
}
process.env.RULEBEAT_ENCRYPTION_KEY ??= 'bench-encryption-key-not-used-for-anything-real';
process.env.AUTH_SECRET ??= 'bench-secret-not-used-for-anything-real';
process.env.AUTH_URL ??= 'http://localhost:3000';
process.env.AZURE_TENANT_ID ??= '00000000-0000-0000-0000-000000000001';

async function main(): Promise<void> {
  const json = args.includes('--json');
  const options = {
    subscriptions: numberFlag(args, '--subscriptions', 2000),
    categories: numberFlag(args, '--categories', 30),
    findings: numberFlag(args, '--findings', 50_000),
    rulesPerCategory: numberFlag(args, '--rules-per-category', 8),
    seed: numberFlag(args, '--seed', 1),
    warmRuns: numberFlag(args, '--warm-runs', 3),
  };
  if (options.subscriptions < 1 || options.categories < 1 || options.findings < 1 || options.rulesPerCategory < 1) {
    throw new Error('--subscriptions, --categories, --findings and --rules-per-category must be at least 1.');
  }

  if (backend === 'postgres') {
    const { dbReady, pgDb } = await import('../lib/db/client');
    const { sql } = await import('drizzle-orm');
    await dbReady;
    // The bench clears the trend points it finds before it writes its own, so history counts as data here too.
    for (const table of ['findings', 'posture_snapshots']) {
      const held = await pgDb!.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`));
      if (Number((held.rows[0] as { n: number }).n) > 0) throw new Error(`That Postgres database already holds rows in ${table}. Give the bench a scratch database.`);
    }
  }

  const { formatTable, runBench } = await import('./bench/trend-points');
  const result = await runBench(options, line => process.stderr.write(`${line}\n`));
  console.log(json ? JSON.stringify(result, null, 2) : formatTable(result));
  if (result.overThreshold.length > 0) process.exitCode = 2;
}

main()
  .catch(err => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Windows refuses to delete a SQLite file that is still open.
    try {
      const { rawSqlite } = await import('../lib/db/client');
      rawSqlite?.close();
    } catch {
      // Nothing was opened if the run failed before the first import reached the client.
    }
    rmSync(tempDir, { recursive: true, force: true });
    if (!hadPasswordFile) rmSync(passwordFile, { force: true });
    // A Postgres pool keeps the process alive.
    if (backend === 'postgres') process.exit(process.exitCode ?? 0);
  });
