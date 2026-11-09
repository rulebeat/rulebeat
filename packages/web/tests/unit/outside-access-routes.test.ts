/**
 * Held-back values (#363) through the routes. A saved view or a dashboard filtered to things a person's Access
 * does not reach still opens. It comes back without those stored values, with one count per place and dimension,
 * and no response body of any route holds a stored held-back value. The Scans page's own address filters keep
 * their marking (#274): a `subscription` the person holds no Scope in answers 200 with nothing and a mark.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createPeople, MATRIX_OWNER, MATRIX_TENANT, SCOPE_SUBSCRIPTION, seedMatrix, share, SUB_ONE, SUB_TWO, type MatrixSeed } from '../helpers/access-matrix';
import { createSavedView, getSavedView, updateSavedView } from '@/lib/db/saved-views';
import { createDashboard, getDashboard, updateDashboard } from '@/lib/db/dashboards';
import { createUser } from '@/lib/db/users';
import { deleteAssignmentsOn, grantAssignmentOn } from '@/lib/db/role-assignments';
import { inTransaction } from '@/lib/db/exec';
import { emptyView, viewFromSearchParams, viewToSearchParams } from '@/lib/finding-view';
import { emptyListCopy, emptyReasonOf, filterChipLabel } from '@/lib/explorer-screen';
import { OUTSIDE_ACCESS_LABEL, type HeldBack } from '@/lib/held-back';

/** The SQL of every query run through `many`, so a test can count the selects made on the findings table. */
const statements = vi.hoisted(() => [] as string[]);
vi.mock('@/lib/db/exec', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/db/exec')>();
  return {
    ...original,
    many: <T,>(query: { all(): T[] }) => {
      statements.push((query as unknown as { toSQL(): { sql: string } }).toSQL().sql);
      return original.many(query);
    },
  };
});
const findingsSelects = () => statements.filter(sql => /\bfrom "findings"/.test(sql)).length;

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const { GET: READ } = await import('@/app/api/views/[id]/route');
const { GET: LIST_VIEWS } = await import('@/app/api/views/route');
const { GET: READ_DASHBOARD } = await import('@/app/api/dashboards/[id]/route');
const { GET: LIST_DASHBOARDS } = await import('@/app/api/dashboards/route');
const { GET: VIEW } = await import('@/app/api/findings/view/route');
const { PATCH: SAVE_VIEW } = await import('@/app/api/views/[id]/route');
const { PUT: SAVE_DASHBOARD } = await import('@/app/api/dashboards/[id]/route');

const { POST: CREATE_VIEW } = await import('@/app/api/views/route');
const { POST: CREATE_DASHBOARD } = await import('@/app/api/dashboards/route');
const { POST: DUPLICATE_DASHBOARD } = await import('@/app/api/dashboards/[id]/duplicate/route');
const stateRoutes = {
  view: {
    share: (await import('@/app/api/views/[id]/share/route')).POST,
    unshare: (await import('@/app/api/views/[id]/unshare/route')).POST,
    handOver: (await import('@/app/api/views/[id]/hand-over/route')).POST,
    takeOver: (await import('@/app/api/views/[id]/take-over/route')).POST,
  },
  dashboard: {
    share: (await import('@/app/api/dashboards/[id]/share/route')).POST,
    unshare: (await import('@/app/api/dashboards/[id]/unshare/route')).POST,
    handOver: (await import('@/app/api/dashboards/[id]/hand-over/route')).POST,
    takeOver: (await import('@/app/api/dashboards/[id]/take-over/route')).POST,
  },
};

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
  }, MATRIX_OWNER);
  if (!view.ok) throw new Error(view.reason);
  await share('saved_views', view.view.id);
  richViewId = view.view.id;
  const dashboard = await createDashboard({
    name: 'Rich dashboard',
    config: {
      filters: { subscriptions: [SUB_TWO, SUB_ONE], resourceGroups: ['rg-two'] },
      widgets: [{ id: 'rich-widget', type: 'stat-card', title: 'W', x: 0, y: 0, w: 4, h: 2, config: { subscriptions: [SUB_TWO] } }],
    },
  }, MATRIX_OWNER);
  if (!dashboard.ok) throw new Error(dashboard.reason);
  await share('dashboards', dashboard.dashboard.id);
  richDashboardId = dashboard.dashboard.id;
});

const signIn = (person: string) => mockAuth.mockResolvedValue({ user: { uid: people[person] } });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

interface OpenedView { query: string; revision: number; heldBack: HeldBack[] }

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
    expect(view.query).not.toContain(SUB_TWO);
    expect(view.heldBack).toEqual([{ place: 'savedView', id: seed.savedViewId, dimension: 'subscription', count: 1 }]);
  });

  it('matches nothing when it is opened on Scans, never the whole of the viewer\'s Access', async () => {
    const view = await open(ONE_SUBSCRIPTION);
    const { filters } = viewFromSearchParams(new URLSearchParams(view.query));
    expect(filters).toEqual([{ field: 'subscription', values: [OUTSIDE_ACCESS_LABEL] }]);
    const result = await read(ONE_SUBSCRIPTION, view.query);
    expect(result.total).toBe(0);
    expect(result.items).toEqual([]);
  });

  it('is returned exactly as stored, with no count, to the Admin', async () => {
    const view = await open('Admin');
    expect(view.query).toBe(`subscription=${SUB_TWO}`);
    expect(view.heldBack).toEqual([]);
  });

  it('counts a resource, and a returned-column value only another subscription has, without naming them', async () => {
    const view = await open(ONE_SUBSCRIPTION, richViewId);
    const { filters } = viewFromSearchParams(new URLSearchParams(view.query));
    // A dimension that is held back in full keeps the placeholder, so the view lists nothing for it.
    expect(filters).toEqual([
      { field: 'subscription', values: [OUTSIDE_ACCESS_LABEL] },
      { field: 'resourceName', values: ['vm-one'] },
      { field: 'row.otherSubColumn', values: [OUTSIDE_ACCESS_LABEL] },
    ]);
    expect(view.heldBack).toEqual([
      { place: 'savedView', id: richViewId, dimension: 'subscription', count: 1 },
      { place: 'savedView', id: richViewId, dimension: 'resourceName', count: 1 },
      { place: 'savedView', id: richViewId, dimension: 'row.otherSubColumn', count: 1 },
    ]);
  });

  it('keeps a resource the person can see only when a finding inside their Access carries it', async () => {
    const view = await open(ONE_GROUP, richViewId);
    // vm-one is in `rg-one`, which this person holds.
    expect(viewFromSearchParams(new URLSearchParams(view.query)).filters).toContainEqual({ field: 'resourceName', values: ['vm-one'] });
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

// A stored value appears in a body as a leaf (a dashboard's array) or inside a query string.
const holds = (text: string, value: string) => leaves(text).some(leaf => leaf === value) || (value.length > 3 && text.includes(value));

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

describe('saving an item back from the trimmed copy', () => {
  const JSON_HEADERS = { 'content-type': 'application/json' };
  // A scoped Editor owns a Shared view and a Shared dashboard that name things outside their subscription. Every
  // save below is made from what the server sent them, as the browser does, and must not drop what they were not sent.
  let editor: string;
  let viewId: string;
  let dashboardId: string;
  const FILTERS = [
    { field: 'subscription' as const, values: [SUB_TWO] },
    { field: 'resourceName' as const, values: ['vm-other-sub', 'vm-one'] },
  ];
  const CONFIG = {
    filters: { subscriptions: [SUB_ONE, SUB_TWO], resourceGroups: [] as string[] },
    widgets: [{ id: 'own-widget', type: 'stat-card' as const, title: 'W', x: 0, y: 0, w: 4, h: 2, config: { subscriptions: [SUB_TWO] } }],
  };

  beforeAll(async () => {
    const created = await createUser({ email: 'scoped-editor@example.com', role: 'editor' });
    if ('error' in created) throw new Error(created.error);
    editor = created.user.id;
    await inTransaction(async tx => {
      await deleteAssignmentsOn(tx, editor);
      await grantAssignmentOn(tx, editor, MATRIX_TENANT, SCOPE_SUBSCRIPTION, 'editor');
    });
    const view = await createSavedView({ name: 'Editor view', tab: 'results', query: viewToSearchParams({ ...emptyView(), filters: FILTERS }).toString() }, editor);
    if (!view.ok) throw new Error(view.reason);
    await share('saved_views', view.view.id);
    viewId = view.view.id;
    const dashboard = await createDashboard({ name: 'Editor dashboard', config: CONFIG }, editor);
    if (!dashboard.ok) throw new Error(dashboard.reason);
    await share('dashboards', dashboard.dashboard.id);
    dashboardId = dashboard.dashboard.id;
  });

  const asEditor = () => mockAuth.mockResolvedValue({ user: { uid: editor } });
  const storedFilters = async () => viewFromSearchParams(new URLSearchParams((await getSavedView(viewId))!.query)).filters;

  // A save carries the revision of the copy it was made from, as the browser's does.
  const patchView = (id: string, body: unknown) =>
    SAVE_VIEW(new Request('http://localhost/api/views/x', { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) }), ctx(id));
  const putDashboard = (id: string, body: unknown) =>
    SAVE_DASHBOARD(new Request('http://localhost/api/dashboards/x', { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(body) }), ctx(id));
  async function saveView(received: OpenedView, query = received.query) {
    asEditor();
    const res = await patchView(viewId, { query, revision: received.revision, opened: received.query });
    expect(res.status).toBe(200);
    return res.json() as Promise<OpenedView>;
  }
  interface OpenedDashboard { config: typeof CONFIG; revision: number; heldBack: HeldBack[] }
  async function saveDashboard(config: unknown, from?: OpenedDashboard) {
    asEditor();
    const received = from ?? await openDashboard();
    const res = await putDashboard(dashboardId, { config, revision: received.revision, opened: received.config });
    expect(res.status).toBe(200);
    return res.json() as Promise<OpenedDashboard>;
  }
  const openAsEditor = async (id = viewId) => {
    asEditor();
    return await (await READ(new Request('http://localhost/api/views/x'), ctx(id))).json() as OpenedView;
  };
  const openDashboard = async (id = dashboardId) => {
    asEditor();
    return await (await READ_DASHBOARD(new Request('http://localhost/api/dashboards/x'), ctx(id))).json() as OpenedDashboard;
  };

  it('keeps every held-back value of a view when the received query is saved back', async () => {
    const received = await openAsEditor();
    expect(received.query).not.toContain('vm-other-sub');
    await saveView(received);
    expect(await storedFilters()).toEqual([
      { field: 'subscription', values: [SUB_TWO] },
      { field: 'resourceName', values: expect.arrayContaining(['vm-other-sub', 'vm-one']) },
    ]);
  });

  it('never stores the placeholder, and still counts what is held back in the answer', async () => {
    const saved = await saveView(await openAsEditor());
    expect(saved.query).not.toContain(SUB_TWO);
    expect((await getSavedView(viewId))!.query).not.toContain(OUTSIDE_ACCESS_LABEL.replaceAll(' ', '+'));
    expect(saved.heldBack).toContainEqual({ place: 'savedView', id: viewId, dimension: 'subscription', count: 1 });
  });

  it('applies what the person did change and keeps the rest held back', async () => {
    const received = await openAsEditor();
    const { filters } = viewFromSearchParams(new URLSearchParams(received.query));
    const query = viewToSearchParams({
      ...emptyView(),
      filters: [...filters.filter(f => f.field !== 'resourceName'), { field: 'severity', values: ['high'] }],
    }).toString();
    await saveView(received, query);
    const stored = await storedFilters();
    expect(stored).toContainEqual({ field: 'subscription', values: [SUB_TWO] });
    expect(stored).toContainEqual({ field: 'resourceName', values: ['vm-other-sub'] });
    expect(stored).toContainEqual({ field: 'severity', values: ['high'] });
  });

  it('keeps every held-back value of a dashboard when the received config is saved back', async () => {
    const received = await openDashboard();
    expect(received.config.filters.subscriptions).toEqual([SUB_ONE]);
    await saveDashboard(received.config, received);
    const stored = (await getDashboard(dashboardId))!.config;
    expect(stored.filters?.subscriptions).toEqual(expect.arrayContaining([SUB_ONE, SUB_TWO]));
    expect(stored.filters?.subscriptions).toHaveLength(2);
    expect(stored.widgets[0]!.config.subscriptions).toEqual([SUB_TWO]);
  });

  it('keeps held-back dashboard values when the person clears what they can see', async () => {
    const saved = await saveDashboard({ ...CONFIG, filters: { subscriptions: [], resourceGroups: [] }, widgets: [] });
    expect((await getDashboard(dashboardId))!.config.filters?.subscriptions).toEqual([SUB_TWO]);
    expect(saved.config.filters.subscriptions).toEqual([]);
    expect(saved.heldBack).toContainEqual({ place: 'dashboard', id: dashboardId, dimension: 'subscription', count: 1 });
  });

  it('refuses a write made on a revision that has since moved on, so a held-back value changed meanwhile is not lost', async () => {
    const current = (await getDashboard(dashboardId))!;
    const stale = await updateDashboard(dashboardId, { config: current.config }, { ifRevision: current.revision - 1 });
    expect(stale).toEqual({ ok: false, reason: 'conflict' });
    const fresh = await updateDashboard(dashboardId, { config: current.config }, { ifRevision: current.revision });
    expect(fresh.ok).toBe(true);
    const view = (await getSavedView(viewId))!;
    expect(await updateSavedView(viewId, { query: view.query }, editor, { ifRevision: view.revision - 1 })).toEqual({ ok: false, reason: 'conflict' });
  });

  describe('a save made from a copy that has since moved on', () => {
    const asAdmin = () => mockAuth.mockResolvedValue({ user: { uid: people.Admin } });

    it('refuses a view the Admin changed after the person opened it, and stores no placeholder', async () => {
      const received = await openAsEditor();
      expect(received.query).toContain(OUTSIDE_ACCESS_LABEL.replaceAll(' ', '+'));
      asAdmin();
      const changed = await patchView(viewId, { query: 'severity=high', revision: received.revision });
      expect(changed.status).toBe(200);

      asEditor();
      const stale = await patchView(viewId, { query: received.query, revision: received.revision, opened: received.query });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toEqual({ error: expect.stringContaining('changed while you were editing') });
      expect((await getSavedView(viewId))!.query).toBe('severity=high');
    });

    it('refuses a dashboard the Admin changed after the person opened it', async () => {
      const received = await openDashboard();
      asAdmin();
      const cleared = await putDashboard(dashboardId, { config: { ...CONFIG, filters: { subscriptions: [], resourceGroups: [] } }, revision: received.revision });
      expect(cleared.status).toBe(200);

      asEditor();
      const stale = await putDashboard(dashboardId, { config: received.config, revision: received.revision, opened: received.config });
      expect(stale.status).toBe(409);
      expect((await getDashboard(dashboardId))!.config.filters?.subscriptions).toEqual([]);
    });

    it('refuses a save that names no revision while the stored item holds values back from the person', async () => {
      await saveDashboard({ ...CONFIG, filters: { subscriptions: [SUB_TWO], resourceGroups: [] } });
      asAdmin();
      const stored = (await getDashboard(dashboardId))!;
      expect(stored.config.filters?.subscriptions).toEqual([SUB_TWO]);

      asEditor();
      const unversioned = await putDashboard(dashboardId, { config: { ...CONFIG, filters: { subscriptions: [], resourceGroups: [] } } });
      expect(unversioned.status).toBe(409);
      expect((await getDashboard(dashboardId))!.config.filters?.subscriptions).toEqual([SUB_TWO]);

      await patchView(viewId, { query: `subscription=${SUB_TWO}`, revision: (await getSavedView(viewId))!.revision });
      const viewUnversioned = await patchView(viewId, { query: 'severity=low' });
      expect(viewUnversioned.status).toBe(409);
      expect((await getSavedView(viewId))!.query).toBe(`subscription=${SUB_TWO}`);
    });

    it('strips the placeholder from a view query even when it names no revision and nothing is held back now', async () => {
      const current = (await getSavedView(viewId))!;
      asAdmin();
      await patchView(viewId, { query: 'severity=high', revision: current.revision });
      asEditor();
      const res = await patchView(viewId, { query: `severity=low&subscription=${OUTSIDE_ACCESS_LABEL.replaceAll(' ', '+')}` });
      expect(res.status).toBe(200);
      expect((await getSavedView(viewId))!.query).toBe('severity=low');
    });
  });

  describe('access that changes between opening an item and saving it', () => {
    const PLACEHOLDER = OUTSIDE_ACCESS_LABEL.replaceAll(' ', '+');
    const grantSubscriptionTwo = () => inTransaction(async tx => {
      await grantAssignmentOn(tx, editor, MATRIX_TENANT, `/subscriptions/${SUB_TWO}`, 'editor');
    });
    const restoreAccess = () => inTransaction(async tx => {
      await deleteAssignmentsOn(tx, editor);
      await grantAssignmentOn(tx, editor, MATRIX_TENANT, SCOPE_SUBSCRIPTION, 'editor');
    });
    afterEach(restoreAccess);

    it('keeps a subscription for everyone when it was granted to the person after they opened the dashboard', async () => {
      const created = await createDashboard({
        name: 'Granted meanwhile',
        config: { filters: { subscriptions: [SUB_ONE, SUB_TWO], resourceGroups: [] }, widgets: [] },
      }, editor);
      if (!created.ok) throw new Error(created.reason);
      await share('dashboards', created.dashboard.id);
      const id = created.dashboard.id;

      asEditor();
      const received = await (await READ_DASHBOARD(new Request('http://localhost/api/dashboards/x'), ctx(id))).json() as OpenedDashboard;
      expect(received.config.filters.subscriptions).toEqual([SUB_ONE]);
      expect(received.heldBack).toEqual([{ place: 'dashboard', id, dimension: 'subscription', count: 1 }]);

      await grantSubscriptionTwo();
      const res = await putDashboard(id, { config: received.config, revision: received.revision, opened: received.config });
      expect(res.status).toBe(200);
      expect((await getDashboard(id))!.config.filters?.subscriptions).toEqual(expect.arrayContaining([SUB_ONE, SUB_TWO]));
      expect((await getDashboard(id))!.config.filters?.subscriptions).toHaveLength(2);
    });

    it('still removes a subscription the person could see and took out', async () => {
      const created = await createDashboard({
        name: 'Removed by the person',
        config: { filters: { subscriptions: [SUB_ONE, SUB_TWO], resourceGroups: [] }, widgets: [] },
      }, editor);
      if (!created.ok) throw new Error(created.reason);
      await share('dashboards', created.dashboard.id);
      const id = created.dashboard.id;

      asEditor();
      const received = await (await READ_DASHBOARD(new Request('http://localhost/api/dashboards/x'), ctx(id))).json() as OpenedDashboard;
      const res = await putDashboard(id, {
        config: { ...received.config, filters: { subscriptions: [], resourceGroups: [] } }, revision: received.revision, opened: received.config,
      });
      expect(res.status).toBe(200);
      expect((await getDashboard(id))!.config.filters?.subscriptions).toEqual([SUB_TWO]);
    });

    it('keeps the real value of a view, never the placeholder, when the value was granted after the person opened it', async () => {
      const created = await createSavedView({ name: 'Granted view', tab: 'results', query: `subscription=${SUB_TWO}` }, editor);
      if (!created.ok) throw new Error(created.reason);
      await share('saved_views', created.view.id);
      const id = created.view.id;

      asEditor();
      const received = await (await READ(new Request('http://localhost/api/views/x'), ctx(id))).json() as OpenedView;
      expect(received.query).toBe(`subscription=${PLACEHOLDER}`);

      await grantSubscriptionTwo();
      const res = await patchView(id, { query: `severity=high&subscription=${PLACEHOLDER}`, revision: received.revision, opened: received.query });
      expect(res.status).toBe(200);
      const stored = (await getSavedView(id))!.query;
      expect(stored).not.toContain(PLACEHOLDER);
      expect(viewFromSearchParams(new URLSearchParams(stored)).filters).toEqual(
        expect.arrayContaining([{ field: 'subscription', values: [SUB_TWO] }, { field: 'severity', values: ['high'] }]),
      );
    });

    it('refuses a view saved on a revision that has moved on, and stores nothing', async () => {
      const created = await createSavedView({ name: 'Moved on view', tab: 'results', query: `subscription=${SUB_TWO}` }, editor);
      if (!created.ok) throw new Error(created.reason);
      await share('saved_views', created.view.id);
      const id = created.view.id;

      asEditor();
      const received = await (await READ(new Request('http://localhost/api/views/x'), ctx(id))).json() as OpenedView;
      expect((await patchView(id, { name: 'Renamed meanwhile', revision: received.revision })).status).toBe(200);
      const before = (await getSavedView(id))!;

      await grantSubscriptionTwo();
      const stale = await patchView(id, { query: 'severity=high', revision: received.revision, opened: received.query });
      expect(stale.status).toBe(409);
      expect(await getSavedView(id)).toEqual(before);
    });
  });
});

/**
 * Every route that returns a dashboard or a saved view, called by a person the stored values are held back from. The
 * checks are on the bodies the routes answer with, whatever the status: a refusal must not name a value either.
 */
describe('every route that returns a dashboard or a saved view, for a person with values held back', () => {
  const JSON_HEADERS = { 'content-type': 'application/json' };
  const HELD = [SUB_TWO, 'vm-other-sub', 'x'];
  const HELD_QUERY = viewToSearchParams({
    ...emptyView(),
    filters: [
      { field: 'subscription', values: [SUB_TWO] },
      { field: 'resourceName', values: ['vm-other-sub', 'vm-one'] },
      { field: 'row.otherSubColumn', values: ['x'] },
    ],
  }).toString();
  const heldConfig = (): DashboardConfigLike => ({
    filters: { subscriptions: [SUB_ONE, SUB_TWO], resourceGroups: [] },
    widgets: [{ id: 'w', type: 'stat-card', title: 'W', x: 0, y: 0, w: 4, h: 2, config: { subscriptions: [SUB_TWO] } }],
  });
  type DashboardConfigLike = Parameters<typeof createDashboard>[0]['config'];

  let scoped: string;
  let serial = 0;
  const name = (label: string) => `${label} ${++serial}`;

  beforeAll(async () => {
    const created = await createUser({ email: 'body-check-editor@example.com', role: 'editor' });
    if ('error' in created) throw new Error(created.error);
    scoped = created.user.id;
    await inTransaction(async tx => {
      await deleteAssignmentsOn(tx, scoped);
      await grantAssignmentOn(tx, scoped, MATRIX_TENANT, SCOPE_SUBSCRIPTION, 'editor');
    });
  });

  const as = (person: string) => mockAuth.mockResolvedValue({ user: { uid: person === 'scoped' ? scoped : people[person] } });
  const json = (method: string, body?: unknown) => ({ method, headers: JSON_HEADERS, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const req = (method = 'POST', body?: unknown) => new Request('http://localhost/api/x', json(method, body));

  /** A Personal saved view or dashboard of `owner` that stores the held values. */
  async function ownView(owner: string) {
    const made = await createSavedView({ name: name('Body view'), tab: 'results', query: HELD_QUERY }, owner === 'scoped' ? scoped : people[owner]!);
    if (!made.ok) throw new Error(made.reason);
    return made.view;
  }
  async function ownDashboard(owner: string) {
    const made = await createDashboard({ name: name('Body dashboard'), config: heldConfig() }, owner === 'scoped' ? scoped : people[owner]!);
    if (!made.ok) throw new Error(made.reason);
    return made.dashboard;
  }

  /** The text of a response, with the stored held-back values and the placeholder rules checked on it. */
  async function clean(res: Response, status: number): Promise<{ text: string; body: Record<string, unknown> }> {
    const text = await res.text();
    expect(res.status, text).toBe(status);
    for (const value of HELD) expect(holds(text, value), `${value} in ${text}`).toBe(false);
    return { text, body: JSON.parse(text) as Record<string, unknown> };
  }
  const counted = (body: Record<string, unknown>) => expect((body.heldBack as HeldBack[]).length).toBeGreaterThan(0);

  describe.each(['scoped', 'No Scope'])('%s: Personal items', person => {
    it('POST /api/views answers the saved view without them', async () => {
      as(person);
      const { body } = await clean(await CREATE_VIEW(req('POST', { name: name('Created view'), tab: 'results', query: HELD_QUERY })), 201);
      counted(body);
    });

    it('PATCH /api/views/[id] answers the saved view without them, for a rename and for a save of the received query', async () => {
      const view = await ownView(person);
      as(person);
      const renamed = await clean(await SAVE_VIEW(req('PATCH', { name: name('Renamed view') }), ctx(view.id)), 200);
      counted(renamed.body);
      const current = (await getSavedView(view.id))!;
      const saved = await clean(await SAVE_VIEW(req('PATCH', { query: `${HELD_QUERY}&severity=high`, revision: current.revision }), ctx(view.id)), 200);
      counted(saved.body);
    });

    it('POST /api/dashboards answers the dashboard without them', async () => {
      as(person);
      const { body } = await clean(await CREATE_DASHBOARD(req('POST', { name: name('Created dashboard'), config: heldConfig() })), 201);
      counted(body);
    });

    it('PUT /api/dashboards/[id] answers the dashboard without them, for a rename, for a config save and for a refused isDefault', async () => {
      const dashboard = await ownDashboard(person);
      as(person);
      const renamed = await clean(await SAVE_DASHBOARD(req('PUT', { name: name('Renamed dashboard') }), ctx(dashboard.id)), 200);
      counted(renamed.body);
      const current = (await getDashboard(dashboard.id))!;
      const saved = await clean(await SAVE_DASHBOARD(req('PUT', { config: heldConfig(), revision: current.revision }), ctx(dashboard.id)), 200);
      counted(saved.body);
      // The Install default is chosen at its own route, so a save that sends isDefault is refused whoever sends it.
      await clean(await SAVE_DASHBOARD(req('PUT', { isDefault: true }), ctx(dashboard.id)), 400);
    });

    it('POST /api/dashboards/[id]/duplicate answers the copy without them', async () => {
      const dashboard = await ownDashboard(person);
      as(person);
      const { body } = await clean(await DUPLICATE_DASHBOARD(req(), ctx(dashboard.id)), 201);
      counted(body);
    });
  });

  describe('scoped: sharing and ownership', () => {
    it('shares, unshares and hands over a saved view, answering each without them', async () => {
      const view = await ownView('scoped');
      as('scoped');
      counted((await clean(await stateRoutes.view.share(req(), ctx(view.id)), 200)).body);
      counted((await clean(await stateRoutes.view.unshare(req(), ctx(view.id)), 200)).body);
      await stateRoutes.view.share(req(), ctx(view.id));
      counted((await clean(await stateRoutes.view.handOver(req('POST', { userId: people.Admin }), ctx(view.id)), 200)).body);
    });

    it('shares, unshares and hands over a dashboard, answering each without them', async () => {
      const dashboard = await ownDashboard('scoped');
      as('scoped');
      counted((await clean(await stateRoutes.dashboard.share(req(), ctx(dashboard.id)), 200)).body);
      counted((await clean(await stateRoutes.dashboard.unshare(req(), ctx(dashboard.id)), 200)).body);
      await stateRoutes.dashboard.share(req(), ctx(dashboard.id));
      counted((await clean(await stateRoutes.dashboard.handOver(req('POST', { userId: people.Admin }), ctx(dashboard.id)), 200)).body);
    });

    it('refuses to take over a Shared item, and the refusal holds none of them', async () => {
      const view = await ownView('Admin');
      const dashboard = await ownDashboard('Admin');
      await share('saved_views', view.id);
      await share('dashboards', dashboard.id);
      as('scoped');
      await clean(await stateRoutes.view.takeOver(req(), ctx(view.id)), 403);
      await clean(await stateRoutes.dashboard.takeOver(req(), ctx(dashboard.id)), 403);
    });

    it('answers the Admin\'s take-over with the item in full and nothing counted, since the Admin holds Everything', async () => {
      const view = await ownView('scoped');
      await share('saved_views', view.id);
      as('Admin');
      const res = await stateRoutes.view.takeOver(req(), ctx(view.id));
      expect(res.status).toBe(200);
      const body = await res.json() as { query: string; heldBack: HeldBack[] };
      expect(body.heldBack).toEqual([]);
      expect(body.query).toContain(SUB_TWO);
    });
  });

  describe('Viewer with no Scope: sharing', () => {
    it('is refused, and the refusal holds none of the values', async () => {
      const view = await ownView('No Scope');
      const dashboard = await ownDashboard('No Scope');
      as('No Scope');
      await clean(await stateRoutes.view.share(req(), ctx(view.id)), 403);
      await clean(await stateRoutes.dashboard.share(req(), ctx(dashboard.id)), 403);
    });
  });

  describe('one findings query per request', () => {
    beforeEach(() => { statements.length = 0; });

    it('PATCH /api/views/[id] reads findings once when it restores the held-back values and answers without them', async () => {
      const view = await ownView('scoped');
      as('scoped');
      statements.length = 0;
      const current = (await getSavedView(view.id))!;
      const res = await SAVE_VIEW(req('PATCH', { query: `${HELD_QUERY}&severity=high`, revision: current.revision }), ctx(view.id));
      expect(res.status).toBe(200);
      expect(findingsSelects()).toBe(1);
    });

    it('GET /api/views reads findings once for every view it lists', async () => {
      as('scoped');
      statements.length = 0;
      expect((await LIST_VIEWS()).status).toBe(200);
      expect(findingsSelects()).toBe(1);
    });
  });
});
