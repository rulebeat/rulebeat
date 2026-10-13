/**
 * #270: the access matrix. Seven people who hold different Scopes call every stored-data GET route through
 * the real `requireRole` (only the session, `@/auth`, is mocked) and the real repositories, over one data
 * set written through the real write paths. Nothing is narrowed yet, so every route is on `NOT_YET_SCOPED`
 * and every person must get a 200 whose body equals the Admin's. A ticket that narrows a route moves it
 * from `NOT_YET_SCOPED` to `MATRIX` and says what each person should now see.
 *
 * The lists are checked against the route files on disk, the way `route-guards.test.ts` checks guards:
 * a route that uses the actor's access must be in exactly one of the two lists, and an entry must name a
 * route file that exists.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createPeople, PEOPLE, seedMatrix, type MatrixSeed } from '../helpers/access-matrix';
import { emptyView, viewToSearchParams } from '@/lib/finding-view';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const API_DIR = path.resolve(__dirname, '../../app/api');

function routeFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) routeFiles(full, found);
    else if (entry === 'route.ts') found.push(full);
  }
  return found;
}

/** `scans/[id]/snapshot` for `app/api/scans/[id]/snapshot/route.ts`. */
const routeName = (file: string): string => path.relative(API_DIR, path.dirname(file)).split(path.sep).join('/');

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** A route reads the person's access when it hands `<something>.access` on to a read. */
export const USES_ACCESS = /\b\w+\.access\b/;

type Probe = (seed: MatrixSeed) => Promise<Response>;

interface NotYetScoped {
  /** The ticket that narrows this route and so moves it to `MATRIX`. */
  ticket: string;
  /** Present for a GET that reads stored data: the matrix calls it for every person. Absent for a route
   *  that calls Azure and for a route listed by hand because it reads no findings-derived data. */
  probe?: Probe;
  /** Why there is no probe. */
  unprobed?: string;
}

interface Matrix {
  probe: Probe;
}

const get = (url: string, route: { GET(req: Request, ctx?: never): Promise<Response> }) => route.GET(new Request(`http://localhost${url}`));
const getWith = (url: string, route: { GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> }, id: string) =>
  route.GET(new Request(`http://localhost${url}`), { params: Promise.resolve({ id }) });

const view = viewToSearchParams(emptyView(), { tab: 'results' }).toString();
const exportOf = (format: string) => `${view}&format=${format}`;

const stored = (probe: Probe, ticket: string): NotYetScoped => ({ ticket, probe });
const azure = (ticket: string): NotYetScoped => ({ ticket, unprobed: 'calls Azure, which a test never does' });
const byHand = (ticket: string): NotYetScoped => ({ ticket, unprobed: 'listed by hand: it reads no findings-derived data and does not take the actor\'s access yet' });

export const NOT_YET_SCOPED: Record<string, NotYetScoped> = {
  'findings/view': stored(async () => get(`/api/findings/view?${view}`, await import('@/app/api/findings/view/route')), '#272'),
  'findings/rows': stored(async seed => get(`/api/findings/rows?${view}&fingerprint=${seed.suppressedFingerprint}`, await import('@/app/api/findings/rows/route')), '#272'),
  'findings/group': stored(async () => get(`/api/findings/group?${view}&group=category&groupPath=%5B%22security%22%5D`, await import('@/app/api/findings/group/route')), '#272'),
  'findings/column-values': stored(async () => get(`/api/findings/column-values?${view}&column=row.zone`, await import('@/app/api/findings/column-values/route')), '#272'),
  'findings/export': stored(async () => get(`/api/findings/export?${exportOf('json')}`, await import('@/app/api/findings/export/route')), '#272'),

  'widgets/summary': stored(async () => get('/api/widgets/summary', await import('@/app/api/widgets/summary/route')), '#274'),
  'widgets/findings': stored(async () => get('/api/widgets/findings', await import('@/app/api/widgets/findings/route')), '#274'),
  'widgets/top-rules': stored(async () => get('/api/widgets/top-rules', await import('@/app/api/widgets/top-rules/route')), '#274'),
  'widgets/top-resources': stored(async () => get('/api/widgets/top-resources', await import('@/app/api/widgets/top-resources/route')), '#274'),
  'widgets/advisories': stored(async () => get('/api/widgets/advisories', await import('@/app/api/widgets/advisories/route')), '#274'),
  'widgets/filter-options': stored(async () => get('/api/widgets/filter-options', await import('@/app/api/widgets/filter-options/route')), '#274'),
  'dashboards': byHand('#274'),
  'dashboards/[id]': byHand('#274'),
  'views': byHand('#274'),
  'views/[id]': byHand('#274'),

  'suppressions': stored(async () => get('/api/suppressions', await import('@/app/api/suppressions/route')), '#275'),
  'azure/subscriptions': byHand('#275'),
  'azure/management-groups': byHand('#275'),
  'azure/scope-tree': byHand('#275'),

  'scans/run': stored(async () => get('/api/scans/run', await import('@/app/api/scans/run/route')), '#276'),
  'scans/[id]/snapshot': stored(async seed => getWith(`/api/scans/${seed.scanIds[1]}/snapshot`, await import('@/app/api/scans/[id]/snapshot/route'), seed.scanIds[1]), '#276'),
  'scans/[id]/snapshot/export': stored(async seed => getWith(`/api/scans/${seed.scanIds[1]}/snapshot/export?format=json`, await import('@/app/api/scans/[id]/snapshot/export/route'), seed.scanIds[1]), '#276'),
  'scans/compare': stored(async seed => get(`/api/scans/compare?compare=${seed.scanIds[0]}..${seed.scanIds[1]}`, await import('@/app/api/scans/compare/route')), '#276'),
  'scans/compare/export': stored(async seed => get(`/api/scans/compare/export?compare=${seed.scanIds[0]}..${seed.scanIds[1]}&format=json`, await import('@/app/api/scans/compare/export/route')), '#276'),
  'schedules': stored(async () => get('/api/schedules', await import('@/app/api/schedules/route')), '#276'),
  'schedules/[id]/run': azure('#276'),
  'schedules/[id]/runs': stored(async seed => getWith(`/api/schedules/${seed.scheduleId}/runs`, await import('@/app/api/schedules/[id]/runs/route'), seed.scheduleId), '#276'),

  'query/run-resource-graph': azure('#277'),
  'query/run-microsoft-graph': azure('#277'),
  'query/run-log-analytics': azure('#277'),
  'rules/validate-kql': azure('#277'),
  'rules/validate-graph': azure('#277'),
  'rules/validate-logs': azure('#277'),
  'rules': azure('#277'),
  'rules/[id]': azure('#277'),

  'schemas': azure('#284'),
  'resources/types': azure('#284'),
  'resources/properties': azure('#284'),
  'diagnostics/preflight': azure('#284'),
};

/** Routes that already narrow what a person sees. None yet: #272 is the first ticket to put one here. */
export const MATRIX: Record<string, Matrix> = {};

export interface ListProblems {
  unlisted: string[];
  inBoth: string[];
  missingFile: string[];
}

/** Compares the two lists with the route files found on disk. */
export function checkLists(
  routes: Map<string, boolean>, matrix: Record<string, unknown>, notYetScoped: Record<string, unknown>,
): ListProblems {
  const unlisted = [...routes].filter(([name, usesAccess]) => usesAccess && !(name in matrix) && !(name in notYetScoped)).map(([name]) => name);
  const inBoth = Object.keys(matrix).filter(name => name in notYetScoped);
  const missingFile = [...Object.keys(matrix), ...Object.keys(notYetScoped)].filter(name => !routes.has(name));
  return { unlisted, inBoth, missingFile };
}

const diskRoutes = new Map<string, boolean>();
for (const file of routeFiles(API_DIR)) diskRoutes.set(routeName(file), USES_ACCESS.test(stripComments(readFileSync(file, 'utf8'))));

describe('the lists are checked against the route files on disk', () => {
  it('finds the routes, and the ones that use the actor\'s access', () => {
    expect(diskRoutes.size).toBeGreaterThan(20);
    for (const name of ['findings/view', 'widgets/summary', 'scans/run', 'schedules/[id]/runs', 'suppressions']) {
      expect(diskRoutes.get(name), name).toBe(true);
    }
    expect([...diskRoutes.values()].filter(Boolean).length).toBeGreaterThan(20);
  });

  it('reads the actor\'s access off a route\'s source and ignores a comment', () => {
    expect(USES_ACCESS.test(stripComments('await queryView(view, q, actor.access);'))).toBe(true);
    expect(USES_ACCESS.test(stripComments('// uses actor.access later\nawait list();'))).toBe(false);
    expect(USES_ACCESS.test(stripComments('/* actor.access */ await list();'))).toBe(false);
  });

  it('has every route that uses the actor\'s access in exactly one list, naming only routes that exist', () => {
    expect(checkLists(diskRoutes, MATRIX, NOT_YET_SCOPED)).toEqual({ unlisted: [], inBoth: [], missingFile: [] });
  });

  it('names the ticket that removes each route from NOT_YET_SCOPED', () => {
    for (const [name, entry] of Object.entries(NOT_YET_SCOPED)) {
      expect(entry.ticket, name).toMatch(/^#\d+$/);
      expect(Boolean(entry.probe) !== Boolean(entry.unprobed), `${name} has a probe or a reason it has none`).toBe(true);
    }
  });

  it('only lists a route file that is there', () => {
    for (const name of Object.keys(NOT_YET_SCOPED)) {
      expect(existsSync(path.join(API_DIR, name, 'route.ts')), name).toBe(true);
    }
  });

  describe('checkLists on fixtures', () => {
    const routes = new Map([['findings/view', true], ['findings/new', true], ['widgets/rules', false], ['views', false]]);

    it('flags a route that uses access and is in neither list', () => {
      expect(checkLists(routes, {}, { 'findings/view': {} }).unlisted).toEqual(['findings/new']);
    });

    it('does not flag a route that does not use access', () => {
      expect(checkLists(routes, {}, { 'findings/view': {}, 'findings/new': {} }).unlisted).toEqual([]);
    });

    it('flags a route in both lists', () => {
      expect(checkLists(routes, { 'findings/view': {} }, { 'findings/view': {}, 'findings/new': {} }).inBoth).toEqual(['findings/view']);
    });

    it('flags an entry naming a route file that no longer exists', () => {
      expect(checkLists(routes, {}, { 'findings/view': {}, 'findings/new': {}, 'findings/gone': {} }).missingFile).toEqual(['findings/gone']);
    });
  });
});

describe('every person reads what the Admin reads', () => {
  const userIds: Record<string, string> = {};
  let seed: MatrixSeed;
  let adminBodies: Record<string, string>;

  const probed = Object.entries(NOT_YET_SCOPED).filter(([, entry]) => entry.probe);

  async function call(person: string, probe: Probe): Promise<{ status: number; body: string }> {
    mockAuth.mockResolvedValue({ user: { uid: userIds[person] } });
    const res = await probe(seed);
    return { status: res.status, body: await res.text() };
  }

  beforeAll(async () => {
    await resetDb();
    Object.assign(userIds, await createPeople());
    seed = await seedMatrix();
    adminBodies = {};
    for (const [name, entry] of probed) adminBodies[name] = (await call('Admin', entry.probe!)).body;
  });

  it('seeds seven people', () => {
    expect(PEOPLE.map(p => p.name)).toEqual([
      'Admin', 'Editor on Everything', 'Viewer on the management group', 'Viewer on one subscription',
      'Viewer on one resource group', 'Directory only', 'No Scope',
    ]);
    expect(Object.keys(userIds)).toHaveLength(7);
  });

  it('runs every stored-data GET, and finds the seeded data in the Admin\'s answers', () => {
    expect(probed.length).toBeGreaterThan(10);
    // Eight findings are stored: one is suppressed and one is an activity finding, so Results lists six.
    const results = JSON.parse(adminBodies['findings/view']!) as { items: unknown[] };
    expect(results.items).toHaveLength(6);
    expect(adminBodies['suppressions']).toContain(seed.suppressedFingerprint);
    expect(adminBodies['schedules/[id]/runs']).toContain(seed.runId);
    expect(adminBodies['scans/[id]/snapshot']).toContain('vm-other-sub');
    expect(adminBodies['scans/compare']).toContain('directory-app');
  });

  for (const person of PEOPLE.map(p => p.name).filter(n => n !== 'Admin')) {
    it(`${person} gets a 200 whose body equals the Admin's from every route`, async () => {
      for (const [name, entry] of probed) {
        const answer = await call(person, entry.probe!);
        expect(answer.status, `${person} ${name}`).toBe(200);
        expect(answer.body, `${person} ${name}`).toBe(adminBodies[name]);
      }
    });
  }
});
