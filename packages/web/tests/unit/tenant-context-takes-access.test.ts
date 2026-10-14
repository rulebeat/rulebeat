/**
 * #270: every route that queries Azure builds its tenant context from the person's access, and nothing under
 * `app/` builds one a back way. Sweeps the source under `app/`, the way `system-access-imports.test.ts`
 * sweeps for the system access:
 *
 *  - `createTenantContext(` is never called with no argument, or with anything but an access;
 *  - `app/` never imports a way to Azure that skips it (`buildTenantContext`, `ResourceGraphClient`,
 *    `createScanContext`, a raw Logs or Graph query function, a credential-level helper), except the
 *    routes in `ALLOWED`, which test a credential or a workspace nobody has saved yet;
 *  - `app/` never builds an `Access` itself (`everythingAccess(`, `buildAccess(`): a route is handed the
 *    one `requireRole` resolved.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB_DIR = path.resolve(__dirname, '../..');
const APP_DIR = path.join(WEB_DIR, 'app');

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, found);
    else if (/\.tsx?$/.test(entry)) found.push(full);
  }
  return found;
}

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** The text of each argument list `createTenantContext(` is called with, up to its closing parenthesis. */
export function tenantContextArguments(source: string): string[] {
  const args: string[] = [];
  const call = /\bcreateTenantContext\s*\(/g;
  for (let m = call.exec(source); m; m = call.exec(source)) {
    let depth = 1;
    let i = call.lastIndex;
    while (i < source.length && depth > 0) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') depth--;
      i++;
    }
    args.push(source.slice(call.lastIndex, i - 1));
  }
  return args;
}

/** The first argument has to be the person's access: `access` or `actor.access`. */
export const IS_ACCESS_ARGUMENT = /^\s*(?:\w+\.)?access\b/;

/** Ways to Azure that do not go through `createTenantContext(access)`. */
export const BACK_WAYS = [
  'buildTenantContext', 'ResourceGraphClient', 'createScanContext',
  'queryLogAnalyticsWorkspace', 'listAccessibleSubscriptions', 'RoleAssignmentsClient',
  'getAzureCredential', 'getAzureToken', 'resolveAzureCredential', 'credentialFromClientSecret',
  'verifyAzureCredential', 'verifyLogAnalyticsWorkspace',
] as const;

export function backWaysUsed(source: string): string[] {
  return BACK_WAYS.filter(name => new RegExp(`\\b${name}\\b`).test(source));
}

/** An `Access` built in the file rather than handed down. */
export const BUILDS_ACCESS = /\b(?:everythingAccess|buildAccess)\s*\(/;

/** The two Admin-only settings routes that test a credential or a workspace nobody has saved yet. They
 *  have no person's access to build a context from: what they verify is whatever was typed. */
const ALLOWED: Record<string, string> = {
  'api/settings/azure-connection/test/route.ts': 'tests a typed, unsaved credential before it is saved',
  'api/settings/log-analytics-workspace/route.ts': 'verifies a typed, unsaved workspace against the stored credential before it is saved',
  'api/settings/azure-connection/route.ts': 'saving a credential verifies the typed one first, the same unsaved credential the test route checks',
};

const rel = (file: string): string => path.relative(APP_DIR, file).split(path.sep).join('/');

const files = sourceFiles(APP_DIR).map(file => ({ file: rel(file), source: stripComments(readFileSync(file, 'utf8')) }));

describe('the sweep finds the files under app/', () => {
  it('finds more than 20 routes and the known ones', () => {
    const routes = files.filter(f => f.file.endsWith('/route.ts'));
    expect(routes.length).toBeGreaterThan(20);
    for (const name of ['api/rules/route.ts', 'api/schemas/route.ts', 'api/query/run-resource-graph/route.ts', 'api/diagnostics/preflight/route.ts']) {
      expect(files.map(f => f.file), name).toContain(name);
    }
    expect(files.some(f => f.file.startsWith('(app)/') && f.file.endsWith('page.tsx'))).toBe(true);
  });

  it('finds the createTenantContext calls the routes make', () => {
    const calls = files.flatMap(f => tenantContextArguments(f.source));
    expect(calls.length).toBeGreaterThan(8);
  });
});

describe('createTenantContext(access)', () => {
  it('reads the arguments of every call, nested parentheses included', () => {
    expect(tenantContextArguments('const c = await createTenantContext();')).toEqual(['']);
    expect(tenantContextArguments('await createTenantContext(actor.access, { run: f(1) });')).toEqual(['actor.access, { run: f(1) }']);
    expect(tenantContextArguments('import { createTenantContext } from "x";')).toEqual([]);
  });

  it('accepts the person\'s access and rejects anything else', () => {
    expect(IS_ACCESS_ARGUMENT.test('actor.access')).toBe(true);
    expect(IS_ACCESS_ARGUMENT.test('access, logContext')).toBe(true);
    expect(IS_ACCESS_ARGUMENT.test('')).toBe(false);
    expect(IS_ACCESS_ARGUMENT.test('undefined')).toBe(false);
    expect(IS_ACCESS_ARGUMENT.test('{ runId }')).toBe(false);
    expect(IS_ACCESS_ARGUMENT.test('accessToken')).toBe(false);
  });

  it('is called with the person\'s access by every file under app/', () => {
    const bad = files.flatMap(f => tenantContextArguments(f.source)
      .filter(arg => !IS_ACCESS_ARGUMENT.test(arg))
      .map(arg => `${f.file}: createTenantContext(${arg})`));
    expect(bad).toEqual([]);
  });
});

describe('app/ has no way to Azure that skips the person\'s access', () => {
  it('spots each way on fixture strings and not a lookalike', () => {
    expect(backWaysUsed("import { buildTenantContext } from '@rulebeat/core';")).toEqual(['buildTenantContext']);
    expect(backWaysUsed('const c = new ResourceGraphClient(token);')).toEqual(['ResourceGraphClient']);
    expect(backWaysUsed("import { createScanContext } from '@/lib/scan-context';")).toEqual(['createScanContext']);
    expect(backWaysUsed('await queryLogAnalyticsWorkspace(cred, id, kql);')).toEqual(['queryLogAnalyticsWorkspace']);
    expect(backWaysUsed('const { buildTenantContext } = await import("@rulebeat/core");')).toEqual(['buildTenantContext']);
    expect(backWaysUsed('import { ResourceGraphTruncatedError } from "@rulebeat/core"; createTenantContext(access);')).toEqual([]);
  });

  it('is clean outside the allowlist', () => {
    const found = files
      .filter(f => !(f.file in ALLOWED))
      .map(f => ({ file: f.file, ways: backWaysUsed(f.source) }))
      .filter(f => f.ways.length > 0);
    expect(found).toEqual([]);
  });

  it('writes down why each allowed route is allowed, and the route still needs it', () => {
    for (const [file, reason] of Object.entries(ALLOWED)) {
      const entry = files.find(f => f.file === file);
      expect(entry, `${file} exists`).toBeDefined();
      expect(reason.length, file).toBeGreaterThan(10);
      expect(backWaysUsed(entry!.source).length, `${file} still uses one`).toBeGreaterThan(0);
    }
  });
});

describe('app/ never builds an Access', () => {
  it('spots a build on fixture strings and not a type import', () => {
    expect(BUILDS_ACCESS.test('const a = everythingAccess("admin");')).toBe(true);
    expect(BUILDS_ACCESS.test('const a = buildAccess(rows);')).toBe(true);
    expect(BUILDS_ACCESS.test("import type { Access } from '@/lib/access-model';")).toBe(false);
    expect(BUILDS_ACCESS.test('const rebuildAccessed = 1;')).toBe(false);
  });

  it('holds for every file under app/', () => {
    expect(files.filter(f => BUILDS_ACCESS.test(f.source)).map(f => f.file)).toEqual([]);
  });
});
