/**
 * Architecture test: product code never imports from `scripts/`.
 *
 * `scripts/` holds one-off tooling run via `tsx`, outside the Next.js build (the repo root's
 * `sync-pack.ts`, `seed-e2e.ts`). Its whole reason to exist is that it can set env vars and
 * dynamic-import DB-touching modules *before* `lib/db/client.ts` opens its connection, and it may
 * assume things the running product must not. The Demo generator used to live here; it moved to
 * `lib/demo/` when the Demo started generating itself at boot, so it is product code now and the
 * wrapper `scripts/generate-demo.ts` imports it, never the other way round.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCANNED_DIRS = ['app', 'lib'];
const SOURCE_EXTENSIONS = ['.ts', '.tsx'];

function findSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    // `readdirSync` walks Next.js's literal `[id]` directories correctly; a PowerShell or glob-based
    // sweep would treat the brackets as a wildcard and skip every dynamic route.
    if (statSync(full).isDirectory()) found.push(...findSourceFiles(full));
    else if (SOURCE_EXTENSIONS.some(ext => entry.endsWith(ext))) found.push(full);
  }
  return found;
}

const sourceFiles = SCANNED_DIRS
  .flatMap(d => findSourceFiles(join(WEB_ROOT, d)))
  .map(full => ({
    rel: relative(WEB_ROOT, full),
    source: readFileSync(full, 'utf8'),
  }));

// Matches an import/require specifier reaching into packages/web/scripts/, however it's spelled:
// the '@/scripts' alias, or a relative path climbing out of app/ or lib/ into it.
const SCRIPTS_IMPORT = /from\s+['"](?:@\/scripts|(?:\.\.\/)+scripts)(?:\/|['"])/;

describe('product code never imports from scripts/', () => {
  it('found the source files at all (guards against this suite silently testing nothing)', async () => {
    expect(sourceFiles.length).toBeGreaterThan(50);
  });

  it('nothing under app/ or lib/ imports from scripts/', async () => {
    const offenders = sourceFiles
      .filter(f => SCRIPTS_IMPORT.test(f.source))
      .map(f => f.rel.split(sep).join('/'));

    expect(offenders, [
      'These files import from scripts/ — one-off tooling (pack sync, e2e seeding) that',
      'runs via tsx outside the app, deliberately never bundled into it. Move shared logic into lib/',
      'and have both the script and the app import that instead.',
    ].join(' ')).toEqual([]);
  });
});
