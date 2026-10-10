// Benchmarks how the explorer's findings view is answered today against how the server answers it
// Run: npm run bench:views --workspace=packages/web -- --findings 10000
//
//   --findings N          findings the first scan saves (default 10000)
//   --rows-per-finding N  average rows each finding holds (default 5)
//   --seed N              the dataset's seed; the same seed gives the same data (default 1)
//   --warm-runs N         runs after the cold one, the median of which is reported (default 3)
//   --json                print the result as JSON instead of a table
//
// It always works in a fresh SQLite file in the temp directory, which it deletes at the end, and
// clears every database variable first so a developer's own Postgres or demo is never touched.
//
// No static imports of anything under lib/ here: RULEBEAT_DB_PATH must be set before
// lib/db/client.ts opens its file, and a static import is hoisted above that assignment.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A fresh database seeds a first-run owner account and writes its password into data/, which is the
// one thing here that lands outside the temp directory. Remove it afterwards unless it was already there.
const passwordFile = join(process.cwd(), 'data', 'initial-password.txt');
const hadPasswordFile = existsSync(passwordFile);
const tempDir = mkdtempSync(join(tmpdir(), 'rulebeat-bench-'));
process.env.RULEBEAT_DB_PATH = join(tempDir, 'bench.db');
for (const name of ['RULEBEAT_DATABASE_URL', 'RULEBEAT_DATABASE_URL_FILE', 'RULEBEAT_DATABASE_BACKEND', 'RULEBEAT_DEMO']) delete process.env[name];
process.env.RULEBEAT_ENCRYPTION_KEY ??= 'bench-encryption-key-not-used-for-anything-real';
process.env.AUTH_SECRET ??= 'bench-secret-not-used-for-anything-real';
process.env.AUTH_URL ??= 'http://localhost:3000';
process.env.AZURE_TENANT_ID ??= '00000000-0000-0000-0000-000000000001';

function numberFlag(args: string[], flag: string, fallback: number): number {
  const at = args.indexOf(flag);
  if (at === -1) return fallback;
  const value = Number(args[at + 1]);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${flag} needs a whole number, not "${args[at + 1] ?? ''}".`);
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const options = {
    findings: numberFlag(args, '--findings', 10_000),
    rowsPerFinding: numberFlag(args, '--rows-per-finding', 5),
    seed: numberFlag(args, '--seed', 1),
    warmRuns: numberFlag(args, '--warm-runs', 3),
  };
  if (options.findings < 1 || options.rowsPerFinding < 1) throw new Error('--findings and --rows-per-finding must be at least 1.');

  const { formatTable, runBench } = await import('./bench/finding-views');
  const result = await runBench(options, line => process.stderr.write(`${line}\n`));
  console.log(json ? JSON.stringify(result, null, 2) : formatTable(result));
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
  });
