/**
 * Architecture test: nothing under `app/` imports `lib/system-access.ts` (#269).
 *
 * The system's Everything is for the scheduler and startup, which act on their own account. A route
 * or page that imported it could hand a request the install's whole access, so the pages and handlers
 * only ever see the Access `requireRole` resolved for the person asking. Same shape as
 * azure-credential-chokepoint.test.ts: a convention the type system cannot express.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYSTEM_ACCESS } from '@/lib/system-access';

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODULE = join('lib', 'system-access.ts');
const SOURCE_EXTENSIONS = ['.ts', '.tsx'];

function findSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    // readdirSync walks Next.js's literal `[id]` and `(app)` directories; a glob would not.
    if (statSync(full).isDirectory()) found.push(...findSourceFiles(full));
    else if (SOURCE_EXTENSIONS.some(ext => entry.endsWith(ext))) found.push(full);
  }
  return found;
}

const read = (full: string) => ({ rel: relative(WEB_ROOT, full).split(sep).join('/'), source: readFileSync(full, 'utf8') });
const appFiles = findSourceFiles(join(WEB_ROOT, 'app')).map(read);

/** Any import, re-export, dynamic import or require whose specifier ends in `system-access`. */
const IMPORTS_SYSTEM_ACCESS = /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)['"`][^'"`]*system-access(?:\.[jt]sx?)?['"`]/;

describe('system access is not reachable from app/', () => {
  it('found the files at all (guards against this suite silently testing nothing)', () => {
    expect(appFiles.length).toBeGreaterThan(50);
    expect(appFiles.some(f => f.rel === 'app/api/users/route.ts')).toBe(true);
  });

  it('the module exists and exports the Everything Access', () => {
    expect(readFileSync(join(WEB_ROOT, MODULE), 'utf8')).toMatch(/export const SYSTEM_ACCESS/);
    expect(SYSTEM_ACCESS).toMatchObject({ everything: true, directory: false, source: null });
    expect(SYSTEM_ACCESS.grants.map(g => g.scope.kind)).toEqual(['everything']);
  });

  it('no file under app/ imports lib/system-access.ts', () => {
    const offenders = appFiles.filter(f => IMPORTS_SYSTEM_ACCESS.test(f.source)).map(f => f.rel);
    expect(offenders, 'These files import the system access, which only the scheduler and startup may use.').toEqual([]);
  });

  it('the pattern catches each way of importing it, so the ban is not vacuous', () => {
    for (const line of [
      `import { SYSTEM_ACCESS } from '@/lib/system-access';`,
      `import { SYSTEM_ACCESS } from "../../lib/system-access";`,
      `export * from '@/lib/system-access';`,
      `const m = await import('@/lib/system-access');`,
      `const m = require('@/lib/system-access.ts');`,
      `import '@/lib/system-access';`,
    ]) expect(IMPORTS_SYSTEM_ACCESS.test(line), line).toBe(true);
    expect(IMPORTS_SYSTEM_ACCESS.test(`import { x } from '@/lib/access';`)).toBe(false);
  });
});
