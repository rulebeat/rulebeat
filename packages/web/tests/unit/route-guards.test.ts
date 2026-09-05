/**
 * TS-04 · Permission enforcement — the "no route is left unguarded" half.
 *
 * The product's whole authorization story rests on one rule: every API route calls
 * `await requireRole(action)`. Nothing in the type system enforces that, so it currently holds because
 * whoever adds a route remembers. This suite makes forgetting impossible — it reads the route
 * files on disk, so a new unguarded route fails the build the moment it's committed, without
 * anyone having to write a test for it.
 *
 * It also pins the *action* each route declares. That turns a silent downgrade (someone changing
 * a delete route from `rules:delete` to plain `read`) into a failing test.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { can, type Action, type Role } from '@/lib/rbac';

// Resolved from this file's own location, not `process.cwd()` — the working directory is the repo
// root when the whole suite runs but the package root when only this project does.
const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const API_DIR = join(WEB_ROOT, 'app', 'api');

/**
 * Two legitimate exceptions, each listed explicitly with the reason — an allowlist that grows
 * without justification is how this kind of test quietly stops working.
 * - The NextAuth catch-all *is* the sign-in mechanism, so it cannot require an existing session.
 * - `/api/health` is a container liveness probe: it must answer before any
 *   session exists and must not touch the database or Azure, so it has nothing to guard.
 */
const UNGUARDED_BY_DESIGN = new Set([
  join('auth', '[...nextauth]', 'route.ts'),
  join('health', 'route.ts'),
]);

function findRouteFiles(dir: string): string[] {
  const found: string[] = [];
  // `readdirSync` handles Next.js's literal `[id]` directories fine; PowerShell's Get-ChildItem
  // does not (it treats the brackets as a glob), which is why this walks the tree in Node.
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...findRouteFiles(full));
    else if (entry === 'route.ts' || entry === 'route.tsx') found.push(full);
  }
  return found;
}

const routeFiles = findRouteFiles(API_DIR).map(full => ({
  rel: relative(API_DIR, full),
  source: readFileSync(full, 'utf8'),
}));

const guarded = routeFiles.filter(r => !UNGUARDED_BY_DESIGN.has(r.rel));

/** The HTTP verbs Next.js will route to. */
const VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

function exportedVerbs(source: string): string[] {
  return VERBS.filter(v =>
    new RegExp(`export\\s+(async\\s+)?function\\s+${v}\\b`).test(source) ||
    new RegExp(`export\\s+const\\s+${v}\\b`).test(source),
  );
}

function declaredActions(source: string): string[] {
  return [...source.matchAll(/requireRole\(\s*'([^']+)'/g)].map(m => m[1]!);
}

describe('TS-04 · every API route is guarded', () => {
  it('found the API routes at all (guards against this suite silently testing nothing)', async () => {
    expect(routeFiles.length).toBeGreaterThan(20);
  });

  it('04-18..28 · every route calls requireRole', async () => {
    const unguarded = guarded
      .filter(r => !r.source.includes('requireRole'))
      .map(r => r.rel.split(sep).join('/'));

    expect(unguarded, [
      'These API routes never call requireRole, so any signed-in user can call them',
      'regardless of role. Add the guard, or — if it genuinely must be public — add it to',
      'UNGUARDED_BY_DESIGN in this file with a written reason.',
    ].join(' ')).toEqual([]);
  });

  it('every route declares an action that exists in the permission model', async () => {
    const bad: string[] = [];
    for (const r of guarded) {
      for (const action of declaredActions(r.source)) {
        // `can('admin', x)` is true for every real action and false for anything invented,
        // which makes it a free "is this a known action" check.
        if (!can('admin', action as Action)) bad.push(`${r.rel.split(sep).join('/')} → '${action}'`);
      }
    }
    expect(bad, 'These routes guard on an action that is not in lib/rbac.ts').toEqual([]);
  });

  it('a route that exports a mutating verb guards it with more than plain read access', async () => {
    const tooWeak: string[] = [];
    for (const r of guarded) {
      const verbs = exportedVerbs(r.source);
      const mutates = verbs.some(v => v !== 'GET');
      if (!mutates) continue;

      const actions = declaredActions(r.source);
      // A mutating route whose only guard is 'read' would let a Viewer change data.
      const onlyRead = actions.length > 0 && actions.every(a => a === 'read');
      if (onlyRead) tooWeak.push(`${r.rel.split(sep).join('/')} (${verbs.join(', ')})`);
    }
    expect(tooWeak, 'These routes mutate data but only require read access').toEqual([]);
  });

  it('every route file exports at least one HTTP verb (no dead route files)', async () => {
    const empty = routeFiles
      .filter(r => exportedVerbs(r.source).length === 0 && !UNGUARDED_BY_DESIGN.has(r.rel))
      .map(r => r.rel.split(sep).join('/'));
    expect(empty).toEqual([]);
  });
});

describe('TS-04 · the actions the sensitive routes require', () => {
  function actionsFor(relPath: string): string[] {
    const file = routeFiles.find(r => r.rel === join(...relPath.split('/')));
    expect(file, `expected an API route at app/api/${relPath}`).toBeDefined();
    return declaredActions(file!.source);
  }

  // These are pinned individually because a downgrade here is a security regression, not a
  // refactor — and it would not otherwise fail any other test.
  const PINNED: Array<[string, Action]> = [
    ['users/route.ts', 'users:manage'],
    ['users/[id]/route.ts', 'users:manage'],
    ['audit/route.ts', 'audit:read'],
    ['categories/route.ts', 'categories:write'],
    ['categories/[id]/route.ts', 'categories:write'],
    ['scans/run/route.ts', 'scans:run'],
    ['rules/validate-kql/route.ts', 'rules:validate'],
    // Reads are admin-only here too: the response names the tenant and app registration RuleBeat
    // scans with, which is deployment configuration rather than findings data.
    ['settings/azure-connection/route.ts', 'azure:manage'],
    ['settings/azure-connection/test/route.ts', 'azure:manage'],
    ['settings/log-analytics-workspace/route.ts', 'azure:manage'],
    ['users/[id]/password/route.ts', 'users:manage'],
    ['account/password/route.ts', 'account:self'],
    ['settings/sign-in/route.ts', 'auth:manage'],
    ['settings/sign-in/test/route.ts', 'auth:manage'],
    ['diagnostics/preflight/route.ts', 'azure:manage'],
    ['rules/bulk/route.ts', 'rules:write'],
    // Clearing a rule's findings is destructive in the same way deleting the rule is (issue #98).
    ['rules/[id]/findings/route.ts', 'rules:delete'],
    ['onboarding/route.ts', 'azure:manage'],
    ['settings/notifications/route.ts', 'notifications:manage'],
    ['settings/notifications/test/route.ts', 'notifications:manage'],
  ];

  for (const [route, action] of PINNED) {
    it(`app/api/${route} requires '${action}'`, async () => {
      expect(actionsFor(route)).toContain(action);
    });
  }

  it("admin-only routes are not reachable by an editor", async () => {
    const adminOnly: Action[] = ['users:manage', 'audit:read', 'categories:write', 'azure:manage', 'auth:manage', 'notifications:manage'];
    for (const action of adminOnly) {
      expect(can('editor' as Role, action)).toBe(false);
      expect(can('viewer' as Role, action)).toBe(false);
      expect(can('admin' as Role, action)).toBe(true);
    }
  });
});
