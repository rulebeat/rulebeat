/**
 * Held-back values (#363) through the routes. A saved view or a dashboard filtered to things a person's Access
 * does not reach still opens. It comes back without those stored values, with one count per place and dimension,
 * and no response body of any route holds a stored held-back value. The Scans page's own address filters keep
 * their marking (#274): a `subscription` the person holds no Scope in answers 200 with nothing and a mark.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createPeople, seedMatrix, SUB_ONE, SUB_TWO, type MatrixSeed } from '../helpers/access-matrix';
import { createSavedView } from '@/lib/db/saved-views';
import { createDashboard } from '@/lib/db/dashboards';
import { emptyView, viewFromSearchParams, viewToSearchParams } from '@/lib/finding-view';
import { emptyListCopy, emptyReasonOf, filterChipLabel } from '@/lib/explorer-screen';
import { OUTSIDE_ACCESS_LABEL, type HeldBack } from '@/lib/held-back';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const { GET: READ } = await import('@/app/api/views/[id]/route');
const { GET: LIST_VIEWS } = await import('@/app/api/views/route');
const { GET: READ_DASHBOARD } = await import('@/app/api/dashboards/[id]/route');
const { GET: LIST_DASHBOARDS } = await import('@/app/api/dashboards/route');
const { GET: VIEW } = await import('@/app/api/findings/view/route');

const ONE_SUBSCRIPTION = 'Viewer on one subscription';
const ONE_GROUP = 'Viewer on one resource group';

let people: Record<string, string>;
let seed: MatrixSeed;
let richViewId: string;
let richDashboardId: string;

/** A saved view that names a subscription, a resource and a returned-column value that only subscription two has. */
const RICH_FILTERS = [
  { field: 'subscription' as const, values: [SUB_TWO] },
  { field: 'resourceName' as const, values: ['vm-other-sub', 'vm-one'] },
  { field: 'row.otherSubColumn' as const, values: ['x'] },
];

beforeAll(async () => {
  await resetDb();
  people = await createPeople();
  seed = await seedMatrix();
  const view = await createSavedView({
    name: 'Rich view', tab: 'results', query: viewToSearchParams({ ...emptyView(), filters: RICH_FILTERS }).toString(),
  }, null);
  if (!view.ok) throw new Error(view.reason);
  richViewId = view.view.id;
  const dashboard = await createDashboard({
    name: 'Rich dashboard',
    config: {
      filters: { subscriptions: [SUB_TWO, SUB_ONE], resourceGroups: ['rg-two'] },
      widgets: [{ id: 'rich-widget', type: 'stat-card', title: 'W', x: 0, y: 0, w: 4, h: 2, config: { subscriptions: [SUB_TWO] } }],
    },
  });
  if (!dashboard.ok) throw new Error(dashboard.reason);
  richDashboardId = dashboard.dashboard.id;
});

const signIn = (person: string) => mockAuth.mockResolvedValue({ user: { uid: people[person] } });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

interface OpenedView { query: string; heldBack: HeldBack[] }

async function open(person: string, id = seed.savedViewId): Promise<OpenedView> {
  signIn(person);
  const res = await READ(new Request('http://localhost/api/views/x'), ctx(id));
  expect(res.status).toBe(200);
  return await res.json() as OpenedView;
}

async function read(person: string, query: string) {
  signIn(person);
  const res = await VIEW(new Request(`http://localhost/api/findings/view?${query}`));
  expect(res.status).toBe(200);
  return await res.json() as { total: number; items: unknown[]; outsideAccess: { subscriptions: string[]; resourceGroups: string[] } };
}

describe('a saved view filtered to subscription two, opened by the Viewer on subscription one', () => {
  it('opens without the subscription and counts it', async () => {
    const view = await open(ONE_SUBSCRIPTION);
    expect(view.query).toBe('');
    expect(view.heldBack).toEqual([{ place: 'savedView', id: seed.savedViewId, dimension: 'subscription', count: 1 }]);
  });

  it('is returned exactly as stored, with no count, to the Admin', async () => {
    const view = await open('Admin');
    expect(view.query).toBe(`subscription=${SUB_TWO}`);
    expect(view.heldBack).toEqual([]);
  });

  it('counts a resource, and a returned-column value only another subscription has, without naming them', async () => {
    const view = await open(ONE_SUBSCRIPTION, richViewId);
    const { filters } = viewFromSearchParams(new URLSearchParams(view.query));
    expect(filters).toEqual([{ field: 'resourceName', values: ['vm-one'] }]);
    expect(view.heldBack).toEqual([
      { place: 'savedView', id: richViewId, dimension: 'subscription', count: 1 },
      { place: 'savedView', id: richViewId, dimension: 'resourceName', count: 1 },
      { place: 'savedView', id: richViewId, dimension: 'row.otherSubColumn', count: 1 },
    ]);
  });

  it('keeps a resource the person can see only when a finding inside their Access carries it', async () => {
    const view = await open(ONE_GROUP, richViewId);
    // vm-one is in `rg-one`, which this person holds.
    expect(viewFromSearchParams(new URLSearchParams(view.query)).filters).toEqual([{ field: 'resourceName', values: ['vm-one'] }]);
  });
});

/** Every string a JSON body holds as a value (its keys are field names, not stored values). */
function leaves(text: string): string[] {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === 'string') out.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') Object.values(node).forEach(walk);
  };
  walk(JSON.parse(text));
  return out;
}

describe('no route response holds a stored held-back value', () => {
  async function bodies(person: string): Promise<string[]> {
    signIn(person);
    return [
      await (await READ(new Request('http://localhost/api/views/x'), ctx(seed.savedViewId))).text(),
      await (await READ(new Request('http://localhost/api/views/x'), ctx(richViewId))).text(),
      await (await LIST_VIEWS()).text(),
      await (await READ_DASHBOARD(new Request('http://localhost/api/dashboards/x'), ctx(seed.dashboardId))).text(),
      await (await READ_DASHBOARD(new Request('http://localhost/api/dashboards/x'), ctx(richDashboardId))).text(),
      await (await LIST_DASHBOARDS()).text(),
    ];
  }
  // A stored value appears in a body as a leaf (a dashboard's array) or inside a query string.
  const holds = (text: string, value: string) => leaves(text).some(leaf => leaf === value) || (value.length > 3 && text.includes(value));

  it('leaves them out for a person who holds one subscription, but not what that person can see', async () => {
    const texts = await bodies(ONE_SUBSCRIPTION);
    for (const text of texts) for (const value of [SUB_TWO, 'vm-other-sub', 'x']) expect(holds(text, value), `${value} in ${text}`).toBe(false);
    // Their own subscription and resource are still there to be read.
    expect(holds(texts[4]!, SUB_ONE)).toBe(true);
    expect(holds(texts[1]!, 'vm-one')).toBe(true);
  });

  it('leaves out every value for a person who holds no Scope', async () => {
    for (const text of await bodies('No Scope')) {
      for (const value of [SUB_TWO, SUB_ONE, 'vm-other-sub', 'vm-one', 'x', 'rg-two']) expect(holds(text, value), `${value} in ${text}`).toBe(false);
    }
  });

  it('leaves them in for the Admin, who holds Everything', async () => {
    const texts = await bodies('Admin');
    expect(holds(texts[0]!, SUB_TWO)).toBe(true);
    expect(holds(texts[1]!, 'vm-other-sub')).toBe(true);
  });

  it('counts the filter bar and each widget of a dashboard on its own', async () => {
    signIn(ONE_SUBSCRIPTION);
    const res = await READ_DASHBOARD(new Request('http://localhost/api/dashboards/x'), ctx(richDashboardId));
    const body = await res.json() as { config: { filters: unknown; widgets: { config: unknown }[] }; heldBack: HeldBack[] };
    expect(body.config.filters).toEqual({ subscriptions: [SUB_ONE], resourceGroups: ['rg-two'] });
    expect(body.config.widgets[0]!.config).toEqual({ subscriptions: [] });
    expect(body.heldBack).toEqual([
      { place: 'dashboard', id: richDashboardId, dimension: 'subscription', count: 1 },
      { place: 'widget', id: 'rich-widget', dimension: 'subscription', count: 1 },
    ]);
  });
});

describe('the Scans page\'s address filters keep their marking', () => {
  const address = `subscription=${SUB_TWO}`;

  it('reads as an empty result carrying the mark, with no 403 or 400', async () => {
    const result = await read(ONE_SUBSCRIPTION, address);
    expect(result.total).toBe(0);
    expect(result.items).toEqual([]);
    expect(result.outsideAccess).toEqual({ subscriptions: [SUB_TWO], resourceGroups: [] });
  });

  it('shows "Outside your access" on the chip and an empty state that names access', async () => {
    const result = await read(ONE_SUBSCRIPTION, address);
    const { filters } = viewFromSearchParams(new URLSearchParams(address));
    const reason = emptyReasonOf({ filters, outsideAccess: result.outsideAccess });
    expect(reason).toBe('access');
    expect(emptyListCopy(reason, 'findings')).not.toContain('No findings match your filters');
    const chip = filterChipLabel('subscription', SUB_TWO, result.outsideAccess, value => `named ${value}`);
    expect(chip).toBe(OUTSIDE_ACCESS_LABEL);
    expect(chip).not.toContain(SUB_TWO);
  });

  it('is unmarked for the Admin, who sees the subscription\'s own finding', async () => {
    const result = await read('Admin', address);
    expect(result.total).toBe(1);
    expect(result.outsideAccess).toEqual({ subscriptions: [], resourceGroups: [] });
  });

  it('keeps the ordinary empty copy for a scoped person whose own estate is clean', async () => {
    const query = `subscription=${SUB_ONE}&severity=low`;
    const result = await read(ONE_SUBSCRIPTION, query);
    expect(result.total).toBe(0);
    expect(result.outsideAccess).toEqual({ subscriptions: [], resourceGroups: [] });
    const { filters } = viewFromSearchParams(new URLSearchParams(query));
    expect(emptyListCopy(emptyReasonOf({ filters, outsideAccess: result.outsideAccess }), 'findings')).toBe('No findings match your filters');
  });
});
