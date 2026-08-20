import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Deliberately no static imports of anything under lib/ here. `RULEBEAT_DEMO=1` must be set
// before lib/db/client.ts's module-load-time DEFAULT_DB_NAME check ever runs — a static import
// is hoisted above the assignment below regardless of where it's written in this file, so the
// real orchestration lives in ./demo/run.ts, reached only through the dynamic import() in main().

const dataDir = join(process.cwd(), 'data');
for (const suffix of ['', '-wal', '-shm']) {
  const file = join(dataDir, `demo.db${suffix}`);
  if (existsSync(file)) rmSync(file);
}

process.env.RULEBEAT_DEMO = '1';

async function main(): Promise<void> {
  const { runGenerator } = await import('./demo/run');
  await runGenerator();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
