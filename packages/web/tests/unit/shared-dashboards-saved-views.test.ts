/**
 * A Shared dashboard uses only Shared saved views (#376, ADR 0012). A widget's config may hold a `savedViewId`.
 * Every dashboard save and every share checks, inside the write transaction, that a Shared dashboard references
 * only Shared views. A widget read resolves the referenced view to one of three states. No widget references a
 * view yet, so the contract is proven with config fixtures, through the real routes, repository and database.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createPeople, MATRIX_OWNER, seedMatrix, share, SUB_ONE, SUB_TWO, type MatrixSeed } from '../helpers/access-matrix';
import { createDashboard, getDashboard } from '@/lib/db/dashboards';
import { createSavedView, getSavedView } from '@/lib/db/saved-views';
import { emptyView, viewToSearchParams } from '@/lib/finding-view';
import { buildWidgetReadParams } from '@/lib/dashboard-filters';
import type { DashboardConfig, WidgetDef } from '@/lib/types';
import type { SavedView } from '@/lib/saved-view-query';
import type { HeldBack } from '@/lib/held-back';
import { sharedDashboardUseNote } from '@/lib/saved-view-reference';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const SAVED_VIEW_LOCK_KEY = 7194826112;
const lockKeys: number[] = [];
// Runs once, inside the open transaction, right after the saved view name lock is taken: the point at which a
// concurrent writer's commit would land between a save's locks and its read of the views.
let afterViewLock: (() => Promise<void>) | null = null;
vi.mock('@/lib/db/exec', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/db/exec')>();
  return {
    ...original,
    pgAdvisoryXactLock: async (tx: Parameters<typeof original.pgAdvisoryXactLock>[0], key: number) => {
      lockKeys.push(key);
      await original.pgAdvisoryXactLock(tx, key);
      const hook = key === SAVED_VIEW_LOCK_KEY ? afterViewLock : null;
      if (hook) {
        afterViewLock = null;
        await hook();
      }
    },
  };
});

const { DASHBOARD_NAME_LOCK_KEY, SAVED_VIEW_NAME_LOCK_KEY } = await import('@/lib/db/name-locks');
const dashboardRoute = await import('@/app/api/dashboards/[id]/route');
const dashboardShare = await import('@/app/api/dashboards/[id]/share/route');
const viewRoute = await import('@/app/api/views/[id]/route');
const viewsRoute = await import('@/app/api/views/route');
const viewUnshare = await import('@/app/api/views/[id]/unshare/route');
const summary = await import('@/app/api/widgets/summary/route');

const EDITOR = 'Editor on Everything';
const READER = 'Viewer on one subscription';
const WINDOW = { dateWindow: { mode: 'relative', days: 7 } } as const;

let people: Record<string, string>;
let seed: MatrixSeed;

beforeAll(async () => {
  await resetDb();
  people = await createPeople();
  seed = await seedMatrix();
});

beforeEach(() => {
  lockKeys.length = 0;
  afterViewLock = null;
  signIn(EDITOR);
});

const signIn = (person: string) => mockAuth.mockResolvedValue({ user: { uid: people[person] } });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const put = (id: string, payload: unknown) => dashboardRoute.PUT(
  new Request('http://localhost/api/dashboards/x', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }), ctx(id),
);
const post = (route: { POST: (req: Request, c: ReturnType<typeof ctx>) => Promise<Response> }, id: string) =>
  route.POST(new Request('http://localhost/api/x', { method: 'POST' }), ctx(id));

let counter = 0;
const unique = (label: string) => `${label} ${++counter} ${Math.random().toString(36).slice(2, 8)}`;

const widget = (title: string, savedViewId?: string): WidgetDef => ({
  id: unique('w'), type: 'stat-card', title, x: 0, y: 0, w: 4, h: 2, config: savedViewId ? { savedViewId } : {},
});
const configOf = (...widgets: WidgetDef[]): DashboardConfig => ({ widgets });

async function makeView(owner: string, options: { shared?: boolean; query?: string } = {}): Promise<SavedView> {
  const made = await createSavedView({ name: unique('View'), tab: 'results', query: options.query ?? '' }, owner);
  if (!made.ok) throw new Error(made.reason);
  if (options.shared) await share('saved_views', made.view.id);
  return (await getSavedView(made.view.id))!;
}

async function makeDashboard(owner: string, config: DashboardConfig, shared: boolean) {
  const made = await createDashboard({ name: unique('Dashboard'), config }, owner);
  if (!made.ok) throw new Error(made.reason);
  if (shared) await share('dashboards', made.dashboard.id);
  return (await getDashboard(made.dashboard.id))!;
}

const REFUSAL_TAIL = 'Change or remove them before saving.';

describe('sharing a dashboard', () => {
  it('is refused with the widget titles when a widget uses a view that is not Shared, and names no view', async () => {
    const mine = await makeView(people[EDITOR]!);
    const dashboard = await makeDashboard(people[EDITOR]!, configOf(widget('First on mine', mine.id), widget('Fine'), widget('Second on mine', mine.id)), false);

    const res = await post(dashboardShare, dashboard.id);

    expect(res.status).toBe(400);
    const error = ((await res.json()) as { error: string }).error;
    expect(error).toBe(`2 widgets use saved views that are no longer shared: First on mine, Second on mine. ${REFUSAL_TAIL}`);
    expect(error).not.toContain(mine.name);
    expect((await getDashboard(dashboard.id))!.visibility).toBe('personal');
  });

  it('gives someone else\'s Personal view and a deleted view the same refusal, which reveals neither name nor existence', async () => {
    const theirs = await makeView(MATRIX_OWNER);
    const dashboard = await makeDashboard(people[EDITOR]!, configOf(widget('On theirs', theirs.id), widget('On nothing', crypto.randomUUID())), false);

    const res = await post(dashboardShare, dashboard.id);

    expect(res.status).toBe(400);
    const error = ((await res.json()) as { error: string }).error;
    expect(error).toBe(`2 widgets use saved views that are no longer shared: On theirs, On nothing. ${REFUSAL_TAIL}`);
    expect(error).not.toContain(theirs.name);
  });

  it('goes through when every view it uses is Shared', async () => {
    const shared = await makeView(MATRIX_OWNER, { shared: true });
    const dashboard = await makeDashboard(people[EDITOR]!, configOf(widget('On shared', shared.id)), false);

    expect((await post(dashboardShare, dashboard.id)).status).toBe(200);
    expect((await getDashboard(dashboard.id))!.visibility).toBe('shared');
  });
});

describe('saving a dashboard', () => {
  it('is refused on a Shared dashboard that uses a view that is not Shared, and nothing is written', async () => {
    const personalView = await makeView(people[EDITOR]!);
    const dashboard = await makeDashboard(people[EDITOR]!, configOf(widget('Plain')), true);

    const res = await put(dashboard.id, { config: configOf(widget('Plain'), widget('Needs sharing', personalView.id)), revision: dashboard.revision });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(`1 widgets use saved views that are no longer shared: Needs sharing. ${REFUSAL_TAIL}`);
    const stored = (await getDashboard(dashboard.id))!;
    expect(stored.revision).toBe(dashboard.revision);
    expect(stored.config).toEqual(dashboard.config);
  });

  it('is refused on every save, a rename included, while a widget still uses a view that is no longer Shared', async () => {
    const view = await makeView(people[EDITOR]!, { shared: true });
    const dashboard = await makeDashboard(people[EDITOR]!, configOf(widget('Uses it', view.id)), true);
    expect((await post(viewUnshare, view.id)).status).toBe(200);

    const res = await put(dashboard.id, { name: unique('Renamed') });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('Uses it');
  });

  it('leaves a Personal dashboard free to use any view', async () => {
    const personalView = await makeView(people[EDITOR]!);
    const dashboard = await makeDashboard(people[EDITOR]!, configOf(widget('Plain')), false);

    const res = await put(dashboard.id, { config: configOf(widget('On mine', personalView.id)) });

    expect(res.status).toBe(200);
  });

  it('is accepted on a Shared dashboard that uses a Shared view', async () => {
    const view = await makeView(MATRIX_OWNER, { shared: true });
    const dashboard = await makeDashboard(people[EDITOR]!, configOf(widget('Plain')), true);

    expect((await put(dashboard.id, { config: configOf(widget('On shared', view.id)) })).status).toBe(200);
  });
});

describe('unsharing or deleting a view that Shared dashboards use', () => {
  it('is allowed, and the view reports how many Shared dashboards use it', async () => {
    const view = await makeView(people[EDITOR]!, { shared: true });
    await makeDashboard(people[EDITOR]!, configOf(widget('A', view.id)), true);
    await makeDashboard(people[EDITOR]!, configOf(widget('B', view.id), widget('C', view.id)), true);
    await makeDashboard(people[EDITOR]!, configOf(widget('Personal use', view.id)), false);

    const read = await viewRoute.GET(new Request('http://localhost/api/views/x'), ctx(view.id));
    expect(((await read.json()) as SavedView).sharedDashboardCount).toBe(2);
    const listed = (await (await viewsRoute.GET()).json()) as SavedView[];
    expect(listed.find(v => v.id === view.id)!.sharedDashboardCount).toBe(2);

    expect((await post(viewUnshare, view.id)).status).toBe(200);
    expect((await getSavedView(view.id))!.visibility).toBe('personal');

    const deleted = await viewRoute.DELETE(new Request('http://localhost/api/views/x', { method: 'DELETE' }), ctx(view.id));
    expect(deleted.status).toBe(204);
    expect(await getSavedView(view.id)).toBeNull();
  });

  it('counts none for a view no Shared dashboard uses', async () => {
    const view = await makeView(people[EDITOR]!, { shared: true });
    const read = await viewRoute.GET(new Request('http://localhost/api/views/x'), ctx(view.id));
    expect(((await read.json()) as SavedView).sharedDashboardCount).toBe(0);
  });
});

describe('the confirmation of an unshare or a delete', () => {
  it('counts the Shared dashboards that use the view, and says nothing when none does', () => {
    expect(sharedDashboardUseNote(0, 'deleted')).toBe('');
    expect(sharedDashboardUseNote(1, 'unshared')).toBe(' 1 Shared dashboard uses it, and their widgets will stop being able to open it.');
    expect(sharedDashboardUseNote(3, 'deleted')).toBe(' 3 Shared dashboards use it, and their widgets will lose it.');
  });
});

type SavedViewState = { state: 'resolved' | 'not-shared' | 'missing'; message?: string; id?: string; query?: string };
type Read = { savedView?: SavedViewState; heldBack?: HeldBack[] };

async function readWidget(person: string, dashboardId: string, widgetId: string): Promise<{ text: string; body: Read }> {
  signIn(person);
  const res = await summary.GET(new Request(`http://localhost/api/widgets/summary?${buildWidgetReadParams({ dashboardId, widgetId }, WINDOW, {})}`));
  expect(res.status).toBe(200);
  const text = await res.text();
  return { text, body: JSON.parse(text) as Read };
}

describe('a widget read that names a widget with a savedViewId', () => {
  it('resolves a Shared view and reports its held-back values as place savedView, without the values', async () => {
    const w = widget('On the view', seed.savedViewId);
    const dashboard = await makeDashboard(MATRIX_OWNER, configOf(w), true);

    const { body, text } = await readWidget(READER, dashboard.id, w.id);

    expect(body.savedView).toMatchObject({ state: 'resolved', id: seed.savedViewId });
    expect(body.heldBack).toEqual([{ place: 'savedView', id: seed.savedViewId, dimension: 'subscription', count: 1 }]);
    expect(text).not.toContain(SUB_TWO);
  });

  it('adds back nothing for a reader who holds everything the view names', async () => {
    const view = await makeView(MATRIX_OWNER, {
      shared: true, query: viewToSearchParams({ ...emptyView(), filters: [{ field: 'subscription', values: [SUB_ONE] }] }).toString(),
    });
    const w = widget('On the view', view.id);
    const dashboard = await makeDashboard(MATRIX_OWNER, configOf(w), true);

    const { body } = await readWidget(READER, dashboard.id, w.id);

    expect(body.savedView).toMatchObject({ state: 'resolved', id: view.id });
    expect(body.heldBack ?? []).toEqual([]);
  });

  it('says the view is no longer shared with the reader when it is now someone else\'s Personal view', async () => {
    const view = await makeView(MATRIX_OWNER);
    const w = widget('On a private view', view.id);
    const dashboard = await makeDashboard(MATRIX_OWNER, configOf(w), true);

    const { body, text } = await readWidget(READER, dashboard.id, w.id);

    expect(body.savedView).toEqual({ state: 'not-shared', message: 'This saved view is no longer shared with you' });
    expect(text).not.toContain(view.name);
  });

  it('resolves the owner\'s own Personal view for its owner', async () => {
    const view = await makeView(people[READER]!);
    const w = widget('On my view', view.id);
    const dashboard = await makeDashboard(MATRIX_OWNER, configOf(w), true);

    expect((await readWidget(READER, dashboard.id, w.id)).body.savedView).toMatchObject({ state: 'resolved', id: view.id });
  });

  it('says the view no longer exists when it was deleted', async () => {
    const w = widget('On a deleted view', crypto.randomUUID());
    const dashboard = await makeDashboard(MATRIX_OWNER, configOf(w), true);

    const { body } = await readWidget(READER, dashboard.id, w.id);

    expect(body.savedView).toEqual({ state: 'missing', message: 'This saved view no longer exists.' });
  });

  it('adds no saved view to a read whose widget has none', async () => {
    const w = widget('Plain');
    const dashboard = await makeDashboard(MATRIX_OWNER, configOf(w), true);

    expect((await readWidget(READER, dashboard.id, w.id)).body.savedView).toBeUndefined();
  });
});

describe('a dashboard save and a view unshare at the same moment', () => {
  it('refuses a save whose view is unshared after the save took its locks, and writes nothing', async () => {
    const view = await makeView(people[EDITOR]!, { shared: true });
    const dashboard = await makeDashboard(people[EDITOR]!, configOf(widget('Plain')), true);
    const before = (await getDashboard(dashboard.id))!;
    let unshareStatus = 0;
    afterViewLock = async () => { unshareStatus = (await post(viewUnshare, view.id)).status; };

    const saved = await put(dashboard.id, { config: configOf(widget('On the view', view.id)) });

    expect(unshareStatus).toBe(200);
    expect(saved.status).toBe(400);
    const stored = (await getDashboard(dashboard.id))!;
    expect(stored.config).toEqual(before.config);
    expect(stored.revision).toBe(before.revision);
  });

  it('refuses a share whose view is unshared after the share took its locks', async () => {
    const view = await makeView(people[EDITOR]!, { shared: true });
    const dashboard = await makeDashboard(people[EDITOR]!, configOf(widget('On the view', view.id)), false);
    let unshareStatus = 0;
    afterViewLock = async () => { unshareStatus = (await post(viewUnshare, view.id)).status; };

    const shared = await post(dashboardShare, dashboard.id);

    expect(unshareStatus).toBe(200);
    expect(shared.status).toBe(400);
    expect((await getDashboard(dashboard.id))!.visibility).toBe('personal');
  });

  it('lets a save win when the unshare only starts after it has committed, and the unshare then follows', async () => {
    const view = await makeView(people[EDITOR]!, { shared: true });
    const dashboard = await makeDashboard(people[EDITOR]!, configOf(widget('Plain')), true);

    const saved = await put(dashboard.id, { config: configOf(widget('On the view', view.id)) });
    const unshared = await post(viewUnshare, view.id);

    expect(saved.status).toBe(200);
    expect(unshared.status).toBe(200);
  });

  it('refuses a save that comes after the unshare', async () => {
    const view = await makeView(people[EDITOR]!, { shared: true });
    const dashboard = await makeDashboard(people[EDITOR]!, configOf(widget('Plain')), true);
    expect((await post(viewUnshare, view.id)).status).toBe(200);

    expect((await put(dashboard.id, { config: configOf(widget('On the view', view.id)) })).status).toBe(400);
  });
});

describe('lock order', () => {
  const ORDER = [DASHBOARD_NAME_LOCK_KEY, SAVED_VIEW_NAME_LOCK_KEY];

  it('is the dashboard name lock, then the saved view name lock, for a dashboard save', async () => {
    const dashboard = await makeDashboard(people[EDITOR]!, configOf(widget('Plain')), true);
    lockKeys.length = 0;
    expect((await put(dashboard.id, { description: 'changed' })).status).toBe(200);
    expect(lockKeys).toEqual(ORDER);
  });

  it('is the same for a dashboard share', async () => {
    const dashboard = await makeDashboard(people[EDITOR]!, configOf(widget('Plain')), false);
    lockKeys.length = 0;
    expect((await post(dashboardShare, dashboard.id)).status).toBe(200);
    expect(lockKeys).toEqual(ORDER);
  });

  it('is the same for a view unshare', async () => {
    const view = await makeView(people[EDITOR]!, { shared: true });
    lockKeys.length = 0;
    expect((await post(viewUnshare, view.id)).status).toBe(200);
    expect(lockKeys).toEqual(ORDER);
  });

  it('is the same for a view delete', async () => {
    const view = await makeView(people[EDITOR]!, { shared: true });
    lockKeys.length = 0;
    expect((await viewRoute.DELETE(new Request('http://localhost/api/views/x', { method: 'DELETE' }), ctx(view.id))).status).toBe(204);
    expect(lockKeys).toEqual(ORDER);
  });
});
