/**
 * Duplicate and save-from-an-open-view (#364, ADR 0012). A copy is Personal and holds only the values its
 * copier can see, and it says how much more it shows than the original: the dashboards that widened are counted
 * in widgets, the saved view in dimensions. Nothing is said when nothing widened.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createPeople, MATRIX_OWNER, seedMatrix, share, SUB_ONE, SUB_TWO } from '../helpers/access-matrix';
import { createDashboard, getDashboard } from '@/lib/db/dashboards';
import { createSavedView, getSavedView } from '@/lib/db/saved-views';
import { emptyView, viewFromSearchParams, viewToSearchParams } from '@/lib/finding-view';
import { OUTSIDE_ACCESS_LABEL, copiedDashboardNotice, copiedViewNotice, copyNoticeWhileOpen, rememberCopiedDashboard, takeCopiedDashboard, type NoticeStore } from '@/lib/held-back';
import type { Dashboard, DashboardConfig, HeldBackDashboard } from '@/lib/types';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const { POST: DUPLICATE } = await import('@/app/api/dashboards/[id]/duplicate/route');
const { POST: CREATE_VIEW } = await import('@/app/api/views/route');
const { GET: READ_VIEW } = await import('@/app/api/views/[id]/route');

const SCOPED = 'Viewer on one subscription';
const NO_SCOPE = 'No Scope';
const ADMIN = 'Admin';

let people: Record<string, string>;
let serial = 0;

beforeAll(async () => {
  await resetDb();
  people = await createPeople();
  await seedMatrix();
});

beforeEach(() => mockAuth.mockReset());

const signIn = (person: string) => mockAuth.mockResolvedValue({ user: { uid: people[person] } });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const widget = (id: string, config: Record<string, unknown> = {}) => ({ id, type: 'stat-card' as const, title: id, x: 0, y: 0, w: 4, h: 2, config });

async function sharedDashboard(config: DashboardConfig): Promise<string> {
  const made = await createDashboard({ name: `Source ${++serial}`, config }, MATRIX_OWNER);
  if (!made.ok) throw new Error(made.reason);
  await share('dashboards', made.dashboard.id);
  return made.dashboard.id;
}

interface Copied extends HeldBackDashboard { widened: number }
async function duplicate(person: string, id: string): Promise<{ copy: Copied; stored: Dashboard }> {
  signIn(person);
  const res = await DUPLICATE(new Request('http://localhost/api/dashboards/x/duplicate', { method: 'POST' }), ctx(id));
  expect(res.status).toBe(201);
  const copy = await res.json() as Copied;
  return { copy, stored: (await getDashboard(copy.id))! };
}

describe('Duplicate a dashboard', () => {
  it('copies a Personal dashboard for a scoped copier that holds none of their held-back values, and keeps savedViewId and no default flag', async () => {
    const id = await sharedDashboard({
      filters: { subscriptions: [SUB_TWO, SUB_ONE] },
      widgets: [widget('w', { subscriptions: [SUB_TWO, SUB_ONE], savedViewId: 'view-1' })],
    });
    const { copy, stored } = await duplicate(SCOPED, id);
    expect(stored).toMatchObject({ visibility: 'personal', owner: { id: people[SCOPED] }, isDefault: false });
    expect(stored.config.filters?.subscriptions).toEqual([SUB_ONE]);
    expect(stored.config.widgets[0]!.config).toEqual({ subscriptions: [SUB_ONE], savedViewId: 'view-1' });
    expect(JSON.stringify(stored)).not.toContain(SUB_TWO);
    expect(JSON.stringify(copy)).not.toContain(SUB_TWO);
    expect(copy.heldBack).toEqual([]);
  });

  it('counts every widget that takes a widened dashboard filter, and none that has its own', async () => {
    const id = await sharedDashboard({
      filters: { subscriptions: [SUB_TWO] },
      widgets: [widget('a'), widget('b'), widget('own', { subscriptions: [SUB_ONE] })],
    });
    const { copy, stored } = await duplicate(SCOPED, id);
    expect(copy.widened).toBe(2);
    expect(stored.config.filters?.subscriptions ?? []).toEqual([]);
  });

  it('counts only the widgets whose own filter widened when the dashboard filter did not', async () => {
    const id = await sharedDashboard({
      filters: { subscriptions: [SUB_ONE] },
      widgets: [widget('all-held', { subscriptions: [SUB_TWO] }), widget('partly-held', { subscriptions: [SUB_TWO, SUB_ONE] }), widget('inherits')],
    });
    const { copy } = await duplicate(SCOPED, id);
    expect(copy.widened).toBe(1);
  });

  it('counts nothing when a held-back value sits beside one the copier can see, since it never matched for them either', async () => {
    const id = await sharedDashboard({ filters: { subscriptions: [SUB_TWO, SUB_ONE] }, widgets: [widget('a'), widget('b', { subscriptions: [SUB_TWO, SUB_ONE] })] });
    const { copy } = await duplicate(SCOPED, id);
    expect(copy.widened).toBe(0);
    expect(copiedDashboardNotice(copy.widened)).toBeNull();
  });

  it('counts nothing for a dashboard that names no Scope, whoever copies it', async () => {
    const id = await sharedDashboard({ filters: { tags: ['prod'] }, widgets: [widget('a')] });
    expect((await duplicate(NO_SCOPE, id)).copy.widened).toBe(0);
  });

  it('keeps everything for a copier who holds Everything', async () => {
    const id = await sharedDashboard({
      filters: { subscriptions: [SUB_TWO] },
      widgets: [widget('a', { subscriptions: [SUB_TWO] }), widget('b')],
    });
    const { copy, stored } = await duplicate(ADMIN, id);
    expect(copy.widened).toBe(0);
    expect(stored.config.filters?.subscriptions).toEqual([SUB_TWO]);
    expect(stored.config.widgets[0]!.config).toEqual({ subscriptions: [SUB_TWO] });
  });

  it('leaves the original as it was', async () => {
    const id = await sharedDashboard({ filters: { subscriptions: [SUB_TWO] }, widgets: [widget('a')] });
    await duplicate(SCOPED, id);
    expect((await getDashboard(id))!.config.filters?.subscriptions).toEqual([SUB_TWO]);
  });
});

describe('the notice on a copied dashboard', () => {
  it('says how many widgets show more, and says nothing for 0', () => {
    expect(copiedDashboardNotice(3)).toBe('Copied as a Personal dashboard. 3 widgets show more than the original, because values outside your access were left out.');
    expect(copiedDashboardNotice(1)).toBe('Copied as a Personal dashboard. 1 widget shows more than the original, because values outside your access were left out.');
    expect(copiedDashboardNotice(0)).toBeNull();
    expect(copiedDashboardNotice(undefined)).toBeNull();
  });
});

describe('the count a Duplicate hands to the copy', () => {
  const memoryStore = (): NoticeStore => {
    const items = new Map<string, string>();
    return { getItem: k => items.get(k) ?? null, setItem: (k, v) => void items.set(k, v), removeItem: k => void items.delete(k) };
  };

  it('is read once, by the copy it was made for', () => {
    const store = memoryStore();
    rememberCopiedDashboard(store, 'copy-1', 3);
    expect(takeCopiedDashboard(store, 'other')).toBe(0);
    expect(takeCopiedDashboard(store, 'copy-1')).toBe(3);
    expect(takeCopiedDashboard(store, 'copy-1')).toBe(0);
  });

  it('is not kept when nothing widened, and nothing in an address can make one', () => {
    const store = memoryStore();
    rememberCopiedDashboard(store, 'copy-1', 0);
    rememberCopiedDashboard(store, 'copy-2', undefined);
    expect(takeCopiedDashboard(store, 'copy-1')).toBe(0);
    expect(takeCopiedDashboard(store, 'copy-2')).toBe(0);
    expect(takeCopiedDashboard(undefined, 'copy-1')).toBe(0);
  });

  it('ignores a stored value that is not a whole number above 0', () => {
    const store = memoryStore();
    for (const bad of ['', '0', '-2', '2.5', 'x']) {
      store.setItem('rulebeat:copied-dashboard:copy-1', bad);
      expect(takeCopiedDashboard(store, 'copy-1')).toBe(0);
    }
  });
});

describe('the notice on a view saved from an open one', () => {
  it('shows only while the view it describes is the open one', () => {
    const notice = { viewId: 'v2', text: 'Saved as a Personal view. 2 filters show more than the original, because values outside your access were left out.' };
    expect(copyNoticeWhileOpen(notice, 'v2')).toBe(notice.text);
    expect(copyNoticeWhileOpen(notice, 'v3')).toBeNull();
    expect(copyNoticeWhileOpen(notice, null)).toBeNull();
    expect(copyNoticeWhileOpen(null, 'v2')).toBeNull();
  });
});

describe('Save a new view from an open saved view', () => {
  const queryOf = (filters: Parameters<typeof viewToSearchParams>[0]['filters']) => viewToSearchParams({ ...emptyView(), filters }).toString();

  async function sharedView(filters: Parameters<typeof viewToSearchParams>[0]['filters']): Promise<string> {
    const made = await createSavedView({ name: `View ${++serial}`, tab: 'results', query: queryOf(filters) }, MATRIX_OWNER);
    if (!made.ok) throw new Error(made.reason);
    await share('saved_views', made.view.id);
    return made.view.id;
  }

  /** Opens the view as the person sees it, then saves what is open as a new view, as the Scans menu does. */
  async function saveFromOpen(person: string, id: string, extra: Record<string, unknown> = {}) {
    signIn(person);
    const opened = await (await READ_VIEW(new Request('http://localhost/api/views/x'), ctx(id))).json() as { query: string };
    const res = await CREATE_VIEW(new Request('http://localhost/api/views', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `Copy ${++serial}`, tab: 'results', query: opened.query, from: id, ...extra }),
    }));
    expect(res.status).toBe(201);
    const body = await res.json() as { id: string; widened: number };
    return { body, stored: (await getSavedView(body.id))! };
  }

  it('makes a Personal view without the held-back values and counts each dimension that now shows more', async () => {
    const id = await sharedView([{ field: 'subscription', values: [SUB_TWO] }, { field: 'resourceName', values: ['vm-other-sub'] }]);
    const { body, stored } = await saveFromOpen(SCOPED, id);
    expect(body.widened).toBe(2);
    expect(stored).toMatchObject({ visibility: 'personal', owner: { id: people[SCOPED] } });
    expect(stored.query).not.toContain(SUB_TWO);
    expect(stored.query).not.toContain('vm-other-sub');
    expect(stored.query).not.toContain(OUTSIDE_ACCESS_LABEL.replaceAll(' ', '+'));
    expect(viewFromSearchParams(new URLSearchParams(stored.query)).filters).toEqual([]);
  });

  it('counts a dimension once, and none that still holds a value the copier can see', async () => {
    const id = await sharedView([{ field: 'subscription', values: [SUB_TWO, SUB_ONE] }, { field: 'resourceName', values: ['vm-other-sub'] }]);
    const { body, stored } = await saveFromOpen(SCOPED, id);
    expect(body.widened).toBe(1);
    expect(viewFromSearchParams(new URLSearchParams(stored.query)).filters).toEqual([{ field: 'subscription', values: [SUB_ONE] }]);
  });

  it('counts a dimension that is still filtered after the copier adds a value of their own', async () => {
    const id = await sharedView([{ field: 'subscription', values: [SUB_TWO] }]);
    signIn(SCOPED);
    const res = await CREATE_VIEW(new Request('http://localhost/api/views', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `Added ${++serial}`, tab: 'results', query: queryOf([{ field: 'subscription', values: [OUTSIDE_ACCESS_LABEL, SUB_ONE] }]), from: id }),
    }));
    expect((await res.json() as { widened: number }).widened).toBe(0);
  });

  it('counts nothing when nothing was held back', async () => {
    const id = await sharedView([{ field: 'subscription', values: [SUB_ONE] }]);
    const { body } = await saveFromOpen(SCOPED, id);
    expect(body.widened).toBe(0);
    expect(copiedViewNotice(body.widened)).toBeNull();
  });

  it('keeps everything for a person who holds Everything', async () => {
    const id = await sharedView([{ field: 'subscription', values: [SUB_TWO] }]);
    const { body, stored } = await saveFromOpen(ADMIN, id);
    expect(body.widened).toBe(0);
    expect(viewFromSearchParams(new URLSearchParams(stored.query)).filters).toEqual([{ field: 'subscription', values: [SUB_TWO] }]);
  });

  it('counts nothing without an open view, and for one the person cannot open', async () => {
    const id = await sharedView([{ field: 'subscription', values: [SUB_TWO] }]);
    expect((await saveFromOpen(SCOPED, id, { from: undefined })).body.widened).toBe(0);
    expect((await saveFromOpen(SCOPED, id, { from: 'no-such-view' })).body.widened).toBe(0);
  });

  it('says how many filters show more, and nothing for 0', () => {
    expect(copiedViewNotice(2)).toBe('Saved as a Personal view. 2 filters show more than the original, because values outside your access were left out.');
    expect(copiedViewNotice(1)).toBe('Saved as a Personal view. 1 filter shows more than the original, because values outside your access were left out.');
    expect(copiedViewNotice(0)).toBeNull();
  });
});
