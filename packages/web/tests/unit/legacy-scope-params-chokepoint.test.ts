/**
 * Architecture test (#392): `subscription=` and `rg=` are read as filters in exactly one file, the finding-view
 * module, where an old link's values become the View's legacy filters. The Scans page translates them to Scope
 * picks on the server and nothing else reads them from an address.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALLOWED = new Set([join('lib', 'finding-view.ts')]);
const SCANNED_DIRS = ['app', 'components', 'lib'];

function findSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...findSourceFiles(full));
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) found.push(full);
  }
  return found;
}

const sourceFiles = SCANNED_DIRS
  .flatMap(d => findSourceFiles(join(WEB_ROOT, d)))
  .map(full => ({ rel: relative(WEB_ROOT, full), source: readFileSync(full, 'utf8') }));

/** A read or removal of the param by name: `params.get('rg')`, `searchParams.has("subscription")`,
 *  `readParam(source, 'rg')`, or `searchParams.rg`. Writing one (`.set`, `.append`) is how a dashboard link is built and is not a read. */
const LEGACY_PARAM_READ = /\b\w*(params|Params|query|Query|search|Search)\w*\??\.(get|getAll|has|delete)\(\s*['"](subscription|rg)['"]|readParam\([^)]*?,\s*['"](subscription|rg)['"]|\b(params|searchParams|source|query)\.(subscription|rg)\b|\b(params|searchParams|source|query)\[\s*['"](subscription|rg)['"]\s*\]/;

describe('subscription= and rg= are read in the finding-view module only', () => {
  it('found the source files at all (guards against this suite silently testing nothing)', () => {
    expect(sourceFiles.length).toBeGreaterThan(100);
    expect(sourceFiles.some(f => f.rel === join('lib', 'finding-view.ts'))).toBe(true);
  });

  it('reads them there, so the pattern can see a read', () => {
    const view = sourceFiles.find(f => f.rel === join('lib', 'finding-view.ts'))!;
    expect(LEGACY_PARAM_READ.test(view.source)).toBe(true);
  });

  it('no other file reads or removes either param by name', () => {
    const offenders = sourceFiles
      .filter(f => !ALLOWED.has(f.rel) && LEGACY_PARAM_READ.test(f.source))
      .map(f => f.rel.split(sep).join('/'));
    expect(offenders, 'Read them through lib/finding-view.ts (legacyScopeValues, withoutLegacyScope), which is where an old link is understood.').toEqual([]);
  });
});
