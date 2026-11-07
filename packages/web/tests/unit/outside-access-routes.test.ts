/**
 * Held-back values (#363) through the routes. A saved view or a dashboard filtered to things a person's Access
 * does not reach still opens. It comes back without those stored values, with one count per place and dimension,
 * and no response body of any route holds a stored held-back value. The Scans page's own address filters keep
 * their marking (#274): a `subscription` the person holds no Scope in answers 200 with nothing and a mark.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
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

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const { GET: READ } = await import('@/app/api/views/[id]/route');
const { GET: LIST_VIEWS } = await import('@/app/api/views/route');
const { GET: READ_DASHBOARD } = await import('@/app/api/dashboards/[id]/route');
const { GET: LIST_DASHBOARDS } = await import('@/app/api/dashboards/route');
const { GET: VIEW } = await import('@/app/api/findings/view/route');
const { PATCH: SAVE_VIEW } = await import('@/app/api/views/[id]/route');
const { PUT: SAVE_DASHBOARD } = await import('@/app/api/dashboards/[id]/route');

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
    const res = await patchView(viewId, { query, revision: received.revision });
    expect(res.status).toBe(200);
    return res.json() as Promise<OpenedView>;
  }
  interface OpenedDashboard { config: typeof CONFIG; revision: number; heldBack: HeldBack[] }
  async function saveDashboard(config: unknown, revision?: number) {
    asEditor();
    const res = await putDashboard(dashboardId, { config, revision: revision ?? (await openDashboard()).revision });
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
    await saveDashboard(received.config, received.revision);
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
      const stale = await patchView(viewId, { query: received.query, revision: received.revision });
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
      const stale = await putDashboard(dashboardId, { config: received.config, revision: received.revision });
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

    it('refuses a view query carrying the placeholder when it names no revision, even when nothing is held back now', async () => {
      const current = (await getSavedView(viewId))!;
      asAdmin();
      await patchView(viewId, { query: 'severity=high', revision: current.revision });
      asEditor();
      const res = await patchView(viewId, { query: `subscription=${OUTSIDE_ACCESS_LABEL.replaceAll(' ', '+')}` });
      expect(res.status).toBe(409);
      expect((await getSavedView(viewId))!.query).toBe('severity=high');
    });
  });
});
