/**
 * Widget reads by dashboard id and widget id (#375, ADR 0012). A widget read names the dashboard and the
 * widget it is for and carries the values the person can see for each place (the page's filters, the
 * widget's own). The server adds back the values each place stores that the person's Access does not reach,
 * then runs `mergeWidgetFilters()`' replace rule unchanged. A dimension that is held back in full matches
 * nothing for the reader and never widens to the whole of their Access.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createPeople, MATRIX_OWNER, seedMatrix, share, SUB_ONE, SUB_TWO, type MatrixSeed } from '../helpers/access-matrix';
import { createDashboard } from '@/lib/db/dashboards';
import { buildWidgetReadParams, mergeWidgetFilters, parseWidgetReadFromSearchParams, type WidgetFilters } from '@/lib/dashboard-filters';
import { OUTSIDE_ACCESS_LABEL, type HeldBack } from '@/lib/held-back';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const routes = {
  summary: (await import('@/app/api/widgets/summary/route')).GET,
  findings: (await import('@/app/api/widgets/findings/route')).GET,
  'top-rules': (await import('@/app/api/widgets/top-rules/route')).GET,
  'top-resources': (await import('@/app/api/widgets/top-resources/route')).GET,
  advisories: (await import('@/app/api/widgets/advisories/route')).GET,
  rules: (await import('@/app/api/widgets/rules/route')).GET,
  'filter-options': (await import('@/app/api/widgets/filter-options/route')).GET,
};
type Route = keyof typeof routes;

const ONE_SUBSCRIPTION = 'Viewer on one subscription';
const NO_SCOPE = 'No Scope';
const WINDOW: WidgetFilters = { dateWindow: { mode: 'relative', days: 7 } };

let people: Record<string, string>;
let seed: MatrixSeed;
/** Filtered to subscription two on the page. 'own-value' overrides it with subscription one, 'inherits' does not. */
let heldDashboardId: string;
let personalDashboardId: string;

beforeAll(async () => {
  await resetDb();
  people = await createPeople();
  seed = await seedMatrix();
  const widget = (id: string, config: Record<string, unknown>) => ({ id, type: 'stat-card' as const, title: id, x: 0, y: 0, w: 4, h: 2, config });
  const made = await createDashboard({
    name: 'Subscription two page',
    config: { filters: { subscriptions: [SUB_TWO] }, widgets: [widget('own-value', { subscriptions: [SUB_ONE] }), widget('inherits', {}), widget('held-own', { subscriptions: [SUB_TWO] })] },
  }, MATRIX_OWNER);
  if (!made.ok) throw new Error(made.reason);
  await share('dashboards', made.dashboard.id);
  heldDashboardId = made.dashboard.id;
  const personal = await createDashboard({ name: 'Private page', config: { widgets: [] } }, MATRIX_OWNER);
  if (!personal.ok) throw new Error(personal.reason);
  personalDashboardId = personal.dashboard.id;
});

const signIn = (person: string) => mockAuth.mockResolvedValue({ user: { uid: people[person] } });

async function ask(route: Route, query: URLSearchParams): Promise<Response> {
  return routes[route](new Request(`http://localhost/api/widgets/${route}?${query}`));
}

/** What the person's browser sends for a widget: the page's visible values, and the widget's own. */
function read(dashboardId: string, widgetId: string | undefined, page: Partial<WidgetFilters>, own: Record<string, unknown> = {}): URLSearchParams {
  return buildWidgetReadParams({ dashboardId, widgetId }, { ...WINDOW, ...page }, own);
}

async function active(person: string, query: URLSearchParams): Promise<number> {
  signIn(person);
  const res = await ask('summary', query);
  expect(res.status).toBe(200);
  return ((await res.json()) as { current: { activeFindings: number } }).current.activeFindings;
}

/** Subscription one, read with no dashboard at all: the count a widget of its own value must reach. */
async function subscriptionOneCount(person: string): Promise<number> {
  return active(person, buildWidgetReadParams(null, { ...WINDOW, subscriptions: [SUB_ONE] }, {}));
}

describe('a dashboard whose Scope filter is all held back from the reader', () => {
  it('counts the value of a widget that has its own, and matches nothing for every other widget', async () => {
    const expected = await subscriptionOneCount(ONE_SUBSCRIPTION);
    expect(expected).toBeGreaterThan(0);
    // The browser was sent no subscription for the page and one for 'own-value'.
    expect(await active(ONE_SUBSCRIPTION, read(heldDashboardId, 'own-value', {}, { subscriptions: [SUB_ONE] }))).toBe(expected);
    expect(await active(ONE_SUBSCRIPTION, read(heldDashboardId, 'inherits', {}))).toBe(0);
  });

  it('matches nothing for a widget whose own values are all held back, and for a read that names no widget', async () => {
    expect(await active(ONE_SUBSCRIPTION, read(heldDashboardId, 'held-own', {}))).toBe(0);
    expect(await active(ONE_SUBSCRIPTION, read(heldDashboardId, undefined, {}))).toBe(0);
  });

  it('matches nothing for a person who holds no Scope, whatever the widget', async () => {
    for (const widget of ['own-value', 'inherits', 'held-own']) expect(await active(NO_SCOPE, read(heldDashboardId, widget, {}))).toBe(0);
  });

  it('adds a visible value next to the held-back one, which still matches nothing', async () => {
    const expected = await subscriptionOneCount(ONE_SUBSCRIPTION);
    expect(await active(ONE_SUBSCRIPTION, read(heldDashboardId, 'inherits', { subscriptions: [SUB_ONE] }))).toBe(expected);
  });

  it('cannot be widened by a request: a placeholder or an omitted ids pair does not remove the marker from a named widget', async () => {
    expect(await active(ONE_SUBSCRIPTION, read(heldDashboardId, 'inherits', { subscriptions: [OUTSIDE_ACCESS_LABEL] }))).toBe(0);
    expect(await active(ONE_SUBSCRIPTION, read(heldDashboardId, 'inherits', { subscriptions: [] }))).toBe(0);
  });

  it('reports what is held back in heldBack, by place', async () => {
    signIn(ONE_SUBSCRIPTION);
    const body = await (await ask('summary', read(heldDashboardId, 'inherits', {}))).json() as { heldBack: HeldBack[] };
    expect(body.heldBack).toEqual([{ place: 'dashboard', id: heldDashboardId, dimension: 'subscription', count: 1 }]);
    const own = await (await ask('summary', read(heldDashboardId, 'held-own', {}))).json() as { heldBack: HeldBack[] };
    expect(own.heldBack).toEqual([
      { place: 'dashboard', id: heldDashboardId, dimension: 'subscription', count: 1 },
      { place: 'widget', id: 'held-own', dimension: 'subscription', count: 1 },
    ]);
  });

  it('reports an array answer in a header, so the list stays a list', async () => {
    signIn(ONE_SUBSCRIPTION);
    const res = await ask('findings', read(heldDashboardId, 'inherits', {}));
    expect(await res.json()).toEqual([]);
    expect(JSON.parse(res.headers.get('X-Held-Back')!)).toEqual([{ place: 'dashboard', id: heldDashboardId, dimension: 'subscription', count: 1 }]);
  });

  it('is not a held-back read for the Admin, who holds Everything: the stored value counts', async () => {
    const withValue = await active('Admin', read(heldDashboardId, 'inherits', { subscriptions: [SUB_TWO] }));
    expect(withValue).toBeGreaterThan(0);
    signIn('Admin');
    const body = await (await ask('summary', read(heldDashboardId, 'inherits', { subscriptions: [SUB_TWO] }))).json() as { heldBack?: HeldBack[] };
    expect(body.heldBack).toBeUndefined();
  });

  it('goes through the same rule for a widget that has not been saved: it has no held-back values of its own', async () => {
    const expected = await subscriptionOneCount(ONE_SUBSCRIPTION);
    expect(await active(ONE_SUBSCRIPTION, read(heldDashboardId, 'not-saved-yet', {}, { subscriptions: [SUB_ONE] }))).toBe(expected);
    expect(await active(ONE_SUBSCRIPTION, read(heldDashboardId, 'not-saved-yet', {}))).toBe(0);
  });

  it('applies the same rule to every route that reads findings', async () => {
    signIn(ONE_SUBSCRIPTION);
    const nothing = read(heldDashboardId, 'inherits', {});
    expect(await (await ask('findings', nothing)).json()).toEqual([]);
    expect(await (await ask('top-rules', nothing)).json()).toEqual([]);
    expect(await (await ask('top-resources', nothing)).json()).toEqual([]);
    expect(((await (await ask('advisories', nothing)).json()) as { total: number }).total).toBe(0);
    const own = read(heldDashboardId, 'own-value', {}, { subscriptions: [SUB_ONE] });
    expect(((await (await ask('findings', own)).json()) as unknown[]).length).toBeGreaterThan(0);
    expect(((await (await ask('top-rules', own)).json()) as unknown[]).length).toBeGreaterThan(0);
    expect(((await (await ask('top-resources', own)).json()) as unknown[]).length).toBeGreaterThan(0);
    expect(((await (await ask('advisories', own)).json()) as { total: number }).total).toBeGreaterThan(0);
  });
});

describe('the dashboard id', () => {
  const everyRoute = Object.keys(routes) as Route[];

  it('answers an unknown id like every route answers one', async () => {
    signIn('Admin');
    for (const route of everyRoute) {
      const res = await ask(route, read('no-such-dashboard', 'w', {}));
      expect(res.status, route).toBe(404);
    }
  });

  it("answers someone else's Personal dashboard like an unknown id, an Admin included", async () => {
    for (const person of ['Admin', ONE_SUBSCRIPTION]) {
      signIn(person);
      for (const route of everyRoute) {
        const res = await ask(route, read(personalDashboardId, 'w', {}));
        expect(res.status, `${person} ${route}`).toBe(404);
        expect(await res.json(), `${person} ${route}`).toEqual({ error: 'Not found' });
      }
    }
  });

  it('opens a Shared dashboard for every route', async () => {
    signIn(ONE_SUBSCRIPTION);
    for (const route of everyRoute) expect((await ask(route, read(seed.dashboardId, 'matrix-widget', {}))).status, route).toBe(200);
  });
});

describe('the request a browser builds', () => {
  it('reads back as the same page filters and widget overrides, with the ids', () => {
    const page: WidgetFilters = {
      categories: ['security'], subscriptions: [SUB_ONE], resourceGroups: ['rg-one'], tags: ['t'], severities: ['high'], ruleIds: ['r1'],
      dateWindow: { mode: 'custom', from: '2026-06-01', to: '2026-06-05' }, includeSuppressed: true,
    };
    const own = { category: 'cost', policyIds: ['r2'], subscriptions: [SUB_TWO], resourceGroups: ['rg-two'], tags: ['u'], severities: ['low'], windowDays: 30 };
    const parsed = parseWidgetReadFromSearchParams(buildWidgetReadParams({ dashboardId: 'd1', widgetId: 'w1' }, page, own));
    expect(parsed.dashboardId).toBe('d1');
    expect(parsed.widgetId).toBe('w1');
    expect(parsed.dashboard).toEqual(page);
    expect(parsed.widget).toEqual(own);
    // The server's merge of the two is the merge the browser used to do itself.
    expect(mergeWidgetFilters(parsed.dashboard, parsed.widget)).toEqual(mergeWidgetFilters(page, own));
  });

  it('is the merged filters as before when it names no dashboard', () => {
    const page: WidgetFilters = { subscriptions: [SUB_ONE], dateWindow: { mode: 'relative', days: 7 } };
    const params = buildWidgetReadParams(null, page, { subscriptions: [SUB_TWO] });
    expect(params.get('dashboardId')).toBeNull();
    expect(params.get('subscriptions')).toBe(SUB_TWO);
  });
});
