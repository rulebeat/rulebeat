/**
 * Remove N values (#371, ADR 0012): whoever may edit a dashboard or saved view can deliberately drop every value
 * held back from them, in one audited action. Removing a widget, a dashboard or a saved view that holds held-back
 * values says how many it holds, and the Save and delete audit entries record the count. Written through the real
 * routes, repository and audit log.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createPeople, MATRIX_OWNER, MATRIX_TENANT, SCOPE_SUBSCRIPTION, seedMatrix, share, SUB_ONE, SUB_TWO } from '../helpers/access-matrix';
import { createSavedView, getSavedView } from '@/lib/db/saved-views';
import { createDashboard, getDashboard } from '@/lib/db/dashboards';
import { listAllAuditEntries } from '@/lib/db/audit';
import { createUser } from '@/lib/db/users';
import { deleteAssignmentsOn, grantAssignmentOn } from '@/lib/db/role-assignments';
import { inTransaction } from '@/lib/db/exec';
import { emptyView, viewFromSearchParams, viewToSearchParams } from '@/lib/finding-view';
import { removeHeldBackConfirmation, removeWidgetConfirmation, heldBackTotal } from '@/lib/held-back';
import { requestRemoveHeldBack } from '@/lib/item-sharing-client';
import { STALE_DASHBOARD_MESSAGE, STALE_VIEW_MESSAGE } from '@/lib/held-back';
import type { DashboardConfig } from '@/lib/types';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const dashboardRoute = await import('@/app/api/dashboards/[id]/route');
const dashboardRemove = await import('@/app/api/dashboards/[id]/remove-held-back/route');
const viewRoute = await import('@/app/api/views/[id]/route');
const viewRemove = await import('@/app/api/views/[id]/remove-held-back/route');

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const JSON_HEADERS = { 'content-type': 'application/json' };
const post = (body?: unknown) => new Request('http://localhost/api/x', {
  method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body ?? {}),
});

let people: Record<string, string>;
let editor: string;
let otherEditor: string;

const asEditor = () => mockAuth.mockResolvedValue({ user: { uid: editor } });
const asPerson = (name: string) => mockAuth.mockResolvedValue({ user: { uid: people[name] } });

const widget = (id: string, config: Record<string, unknown> = {}) =>
  ({ id, type: 'stat-card' as const, title: id, x: 0, y: 0, w: 4, h: 2, config });
const CONFIG: DashboardConfig = {
  autoRefresh: 0,
  filters: { subscriptions: [SUB_ONE, SUB_TWO], resourceGroups: [] },
  widgets: [widget('own', { subscriptions: [SUB_TWO] }), widget('plain', { subscriptions: [SUB_ONE] })],
} as DashboardConfig;
// Three values held back from the scoped Editor: one in the filter bar and one in each of two widgets.
const HOLDING: DashboardConfig = { ...CONFIG, widgets: [...CONFIG.widgets, widget('other', { subscriptions: [SUB_TWO] })] } as DashboardConfig;

const VIEW_FILTERS = [
  { field: 'subscription' as const, values: [SUB_TWO] },
  { field: 'resourceName' as const, values: ['vm-other-sub', 'vm-one'] },
];
const viewQuery = () => viewToSearchParams({ ...emptyView(), filters: VIEW_FILTERS }).toString();

async function dashboardOf(owner: string, name: string, visibility: 'personal' | 'shared', config = HOLDING) {
  const made = await createDashboard({ name, config }, owner);
  if (!made.ok) throw new Error(made.reason);
  if (visibility === 'shared') await share('dashboards', made.dashboard.id);
  return (await getDashboard(made.dashboard.id))!;
}
async function viewOf(owner: string, name: string, visibility: 'personal' | 'shared') {
  const made = await createSavedView({ name, tab: 'results', query: viewQuery() }, owner);
  if (!made.ok) throw new Error(made.reason);
  if (visibility === 'shared') await share('saved_views', made.view.id);
  return (await getSavedView(made.view.id))!;
}

async function auditOf(id: string) {
  return (await listAllAuditEntries()).filter(e => e.entityId === id);
}

beforeAll(async () => {
  await resetDb();
  people = await createPeople();
  await seedMatrix();
  const make = async (email: string) => {
    const created = await createUser({ email, role: 'editor' });
    if ('error' in created) throw new Error(created.error);
    await inTransaction(async tx => {
      await deleteAssignmentsOn(tx, created.user.id);
      await grantAssignmentOn(tx, created.user.id, MATRIX_TENANT, SCOPE_SUBSCRIPTION, 'editor');
    });
    return created.user.id;
  };
  editor = await make('remove-editor@example.com');
  otherEditor = await make('remove-other-editor@example.com');
});

describe('removing the held-back values of a dashboard', () => {
  it('drops every value held back from the editor, in the filter bar and in every widget, and keeps the rest', async () => {
    const d = await dashboardOf(editor, 'Shared holding', 'shared');
    asEditor();
    const res = await dashboardRemove.POST(post({ revision: d.revision }), ctx(d.id));
    expect(res.status).toBe(200);
    const body = await res.json() as { heldBack: unknown[]; revision: number };
    expect(body.heldBack).toEqual([]);

    const stored = (await getDashboard(d.id))!;
    expect(stored.revision).toBe(d.revision + 1);
    expect(stored.config.filters?.subscriptions).toEqual([SUB_ONE]);
    expect(stored.config.widgets.map(w => w.config)).toEqual([{ subscriptions: [] }, { subscriptions: [SUB_ONE] }, { subscriptions: [] }]);
    expect(JSON.stringify(body)).not.toContain(SUB_TWO);
  });

  it('is refused with 409 when the revision is stale, and changes nothing', async () => {
    const d = await dashboardOf(editor, 'Shared stale', 'shared');
    asEditor();
    const res = await dashboardRemove.POST(post({ revision: d.revision - 1 }), ctx(d.id));
    expect(res.status).toBe(409);
    const stored = (await getDashboard(d.id))!;
    expect(stored.revision).toBe(d.revision);
    expect(stored.config.filters?.subscriptions).toEqual([SUB_ONE, SUB_TWO]);
  });

  it('logs dashboard.remove_held_back with the count only for a Shared dashboard', async () => {
    const d = await dashboardOf(editor, 'Shared audited', 'shared');
    asEditor();
    expect((await dashboardRemove.POST(post({ revision: d.revision }), ctx(d.id))).status).toBe(200);
    const [entry] = (await auditOf(d.id)).filter(e => e.action === 'dashboard.remove_held_back');
    expect(entry!.summary).toContain('Shared audited');
    expect(entry!.details).toEqual({ heldBackCount: 3 });
    expect(JSON.stringify(entry)).not.toContain(SUB_TWO);
  });

  it('logs a Personal dashboard by id, kind and count only', async () => {
    const d = await dashboardOf(editor, 'Private holding name', 'personal');
    asEditor();
    expect((await dashboardRemove.POST(post({ revision: d.revision }), ctx(d.id))).status).toBe(200);
    const [entry] = (await auditOf(d.id)).filter(e => e.action === 'dashboard.remove_held_back');
    expect(entry!.entityType).toBe('dashboard');
    expect(entry!.details).toEqual({ heldBackCount: 3 });
    expect(JSON.stringify(entry)).not.toContain('Private holding name');
  });

  it('writes nothing and logs nothing when nothing is held back from the person', async () => {
    const d = await dashboardOf(editor, 'Shared nothing', 'shared', { ...CONFIG, filters: { subscriptions: [SUB_ONE] }, widgets: [widget('a', { subscriptions: [SUB_ONE] })] } as DashboardConfig);
    asEditor();
    const res = await dashboardRemove.POST(post({ revision: d.revision }), ctx(d.id));
    expect(res.status).toBe(200);
    expect((await getDashboard(d.id))!.revision).toBe(d.revision);
    expect((await auditOf(d.id)).filter(e => e.action === 'dashboard.remove_held_back')).toEqual([]);
  });

  it('is for whoever may edit the item: a scoped Editor who does not own a Shared one gets 403, a Viewer 403', async () => {
    const d = await dashboardOf(editor, 'Shared not yours', 'shared');
    mockAuth.mockResolvedValue({ user: { uid: otherEditor } });
    expect((await dashboardRemove.POST(post({ revision: d.revision }), ctx(d.id))).status).toBe(403);
    asPerson('Viewer on one subscription');
    expect((await dashboardRemove.POST(post({ revision: d.revision }), ctx(d.id))).status).toBe(403);
    expect((await getDashboard(d.id))!.revision).toBe(d.revision);
  });

  it('answers someone else\'s Personal dashboard like an unknown id, an Admin included', async () => {
    const d = await dashboardOf(editor, 'Personal not yours', 'personal');
    asPerson('Admin');
    expect((await dashboardRemove.POST(post({ revision: d.revision }), ctx(d.id))).status).toBe(404);
    expect((await dashboardRemove.POST(post(), ctx('no-such-id'))).status).toBe(404);
  });

  it('lets an Admin, who holds Everything, call it and finds nothing to remove', async () => {
    const d = await dashboardOf(editor, 'Shared for admin', 'shared');
    asPerson('Admin');
    const res = await dashboardRemove.POST(post({ revision: d.revision }), ctx(d.id));
    expect(res.status).toBe(200);
    expect((await getDashboard(d.id))!.config.filters?.subscriptions).toEqual([SUB_ONE, SUB_TWO]);
  });

  it('leaves the values of a saved view a widget uses alone', async () => {
    const view = await viewOf(editor, 'Referenced view', 'shared');
    const config = { ...HOLDING, widgets: [{ ...widget('uses-view', { subscriptions: [SUB_TWO] }), config: { subscriptions: [SUB_TWO], savedViewId: view.id } }] } as DashboardConfig;
    const d = await dashboardOf(editor, 'Shared referencing', 'shared', config);
    asEditor();
    expect((await dashboardRemove.POST(post({ revision: d.revision }), ctx(d.id))).status).toBe(200);
    expect((await getSavedView(view.id))!.query).toBe(view.query);
    expect((await getDashboard(d.id))!.config.widgets[0]!.config).toMatchObject({ savedViewId: view.id });
  });
});

describe('removing the held-back values of a saved view', () => {
  it('drops every value held back from the editor and the filter that was held back in full', async () => {
    const v = await viewOf(editor, 'Shared view holding', 'shared');
    asEditor();
    const res = await viewRemove.POST(post({ revision: v.revision }), ctx(v.id));
    expect(res.status).toBe(200);
    const stored = (await getSavedView(v.id))!;
    expect(stored.revision).toBe(v.revision + 1);
    expect(viewFromSearchParams(new URLSearchParams(stored.query)).filters).toEqual([{ field: 'resourceName', values: ['vm-one'] }]);
    const [entry] = (await auditOf(v.id)).filter(e => e.action === 'view.remove_held_back');
    expect(entry!.details).toEqual({ heldBackCount: 2 });
    expect(entry!.summary).toContain('Shared view holding');
  });

  it('is refused with 409 when the revision is stale', async () => {
    const v = await viewOf(editor, 'Shared view stale', 'shared');
    asEditor();
    expect((await viewRemove.POST(post({ revision: v.revision + 5 }), ctx(v.id))).status).toBe(409);
    expect((await getSavedView(v.id))!.query).toBe(v.query);
  });

  it('logs a Personal view by id, kind and count only', async () => {
    const v = await viewOf(editor, 'Private view name', 'personal');
    asEditor();
    expect((await viewRemove.POST(post({ revision: v.revision }), ctx(v.id))).status).toBe(200);
    const [entry] = (await auditOf(v.id)).filter(e => e.action === 'view.remove_held_back');
    expect(entry!.entityType).toBe('saved_view');
    expect(entry!.details).toEqual({ heldBackCount: 2 });
    expect(JSON.stringify(entry)).not.toContain('Private view name');
  });

  it('is refused for a Viewer on a Shared view (403) and answers 404 for someone else\'s Personal view', async () => {
    const shared = await viewOf(editor, 'Shared view viewer', 'shared');
    const personal = await viewOf(editor, 'Personal view other', 'personal');
    asPerson('Viewer on one subscription');
    expect((await viewRemove.POST(post({ revision: shared.revision }), ctx(shared.id))).status).toBe(403);
    asPerson('Admin');
    expect((await viewRemove.POST(post({ revision: personal.revision }), ctx(personal.id))).status).toBe(404);
  });
});

describe('removing a widget that holds held-back values', () => {
  const putConfig = (id: string, config: DashboardConfig, revision: number) => dashboardRoute.PUT(
    new Request('http://localhost/api/dashboards/x', { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ config, revision }) }), ctx(id));

  async function opened(id: string) {
    asEditor();
    return await (await dashboardRoute.GET(new Request('http://localhost/api/dashboards/x'), ctx(id))).json() as { config: DashboardConfig; revision: number };
  }

  it('records the count on the Save of a Shared dashboard, beside the changed field names', async () => {
    const d = await dashboardOf(editor, 'Shared drop widget', 'shared');
    const copy = await opened(d.id);
    const config = { ...copy.config, widgets: copy.config.widgets.filter(w => w.id !== 'own') } as DashboardConfig;
    expect((await putConfig(d.id, config, copy.revision)).status).toBe(200);
    const entry = (await auditOf(d.id)).find(e => e.action === 'dashboard.update')!;
    expect(entry.details).toEqual({ fields: ['widgets', 'layout'], heldBackCount: 1 });
  });

  it('records nothing about held-back values when the removed widget held none', async () => {
    const d = await dashboardOf(editor, 'Shared drop plain', 'shared');
    const copy = await opened(d.id);
    const config = { ...copy.config, widgets: copy.config.widgets.filter(w => w.id !== 'plain') } as DashboardConfig;
    expect((await putConfig(d.id, config, copy.revision)).status).toBe(200);
    const entry = (await auditOf(d.id)).find(e => e.action === 'dashboard.update')!;
    expect(entry.details).not.toHaveProperty('heldBackCount');
  });

  it('logs a Personal dashboard\'s Save by id, kind and count only, and a Save without the count not at all', async () => {
    const d = await dashboardOf(editor, 'Private drop widget', 'personal');
    const copy = await opened(d.id);
    const plain = { ...copy.config, widgets: copy.config.widgets.filter(w => w.id !== 'plain') } as DashboardConfig;
    expect((await putConfig(d.id, plain, copy.revision)).status).toBe(200);
    expect(await auditOf(d.id)).toEqual([]);

    const next = await opened(d.id);
    const config = { ...next.config, widgets: next.config.widgets.filter(w => w.id !== 'own') } as DashboardConfig;
    expect((await putConfig(d.id, config, next.revision)).status).toBe(200);
    const entries = await auditOf(d.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.details).toEqual({ heldBackCount: 1 });
    expect(JSON.stringify(entries[0])).not.toContain('Private drop widget');
  });
});

describe('deleting an item that holds held-back values', () => {
  it('records the count on the delete of a dashboard, and none when it holds none', async () => {
    const d = await dashboardOf(editor, 'Shared delete holding', 'shared');
    asEditor();
    expect((await dashboardRoute.DELETE(new Request('http://localhost/api/dashboards/x', { method: 'DELETE' }), ctx(d.id))).status).toBe(204);
    expect((await auditOf(d.id)).find(e => e.action === 'dashboard.delete')!.details).toEqual({ heldBackCount: 3 });

    const clean = await dashboardOf(editor, 'Shared delete clean', 'shared', { ...CONFIG, filters: { subscriptions: [SUB_ONE] }, widgets: [] } as DashboardConfig);
    expect((await dashboardRoute.DELETE(new Request('http://localhost/api/dashboards/x', { method: 'DELETE' }), ctx(clean.id))).status).toBe(204);
    expect((await auditOf(clean.id)).find(e => e.action === 'dashboard.delete')!.details ?? {}).not.toHaveProperty('heldBackCount');
  });

  it('records the count on the delete of a Personal dashboard without its name', async () => {
    const d = await dashboardOf(editor, 'Private delete name', 'personal');
    asEditor();
    expect((await dashboardRoute.DELETE(new Request('http://localhost/api/dashboards/x', { method: 'DELETE' }), ctx(d.id))).status).toBe(204);
    const entry = (await auditOf(d.id)).find(e => e.action === 'dashboard.delete')!;
    expect(entry.details).toEqual({ heldBackCount: 3 });
    expect(JSON.stringify(entry)).not.toContain('Private delete name');
  });

  it('records the count on the delete of a saved view', async () => {
    const v = await viewOf(editor, 'Shared view delete', 'shared');
    asEditor();
    expect((await viewRoute.DELETE(new Request('http://localhost/api/views/x', { method: 'DELETE' }), ctx(v.id))).status).toBe(204);
    const entry = (await auditOf(v.id)).find(e => e.action === 'view.delete')!;
    expect(entry.details).toMatchObject({ heldBackCount: 2 });
  });
});

describe('the words', () => {
  it('asks to remove the values from the item by name and says everyone who could see them loses them', () => {
    expect(removeHeldBackConfirmation(3, 'Ops board'))
      .toBe('Remove 3 values outside your access from Ops board? Everyone who could see them loses them.');
    expect(removeHeldBackConfirmation(1, 'Ops board')).toContain('Remove 1 value outside your access from');
  });

  it('warns that removing a widget removes the values it holds', () => {
    expect(removeWidgetConfirmation(2)).toBe('This widget holds 2 values outside your access. Removing it removes them.');
    expect(removeWidgetConfirmation(1)).toBe('This widget holds 1 value outside your access. Removing it removes them.');
  });

  it('adds up the counts of every place and dimension', () => {
    expect(heldBackTotal([
      { place: 'dashboard', id: 'd', dimension: 'subscription', count: 2 },
      { place: 'widget', id: 'w', dimension: 'resourceGroup', count: 1 },
    ])).toBe(3);
    expect(heldBackTotal(undefined)).toBe(0);
  });
});

describe('the page\'s request for "Remove N values"', () => {
  const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it('posts the revision of the copy the count was read on to the item\'s own route', async () => {
    const fetchImpl = answer(200, { id: 'd1', revision: 5 });
    expect(await requestRemoveHeldBack('dashboard', 'd1', 4, fetchImpl)).toEqual({ ok: true, item: { id: 'd1', revision: 5 } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/dashboards/d1/remove-held-back');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ revision: 4 });
    const view = answer(200, {});
    await requestRemoveHeldBack('view', 'v1', 2, view);
    expect((view.mock.calls[0] as unknown as [string])[0]).toBe('/api/views/v1/remove-held-back');
  });

  it('reports a stale copy as stale with the server\'s words, and other refusals without it', async () => {
    expect(await requestRemoveHeldBack('dashboard', 'd1', 4, answer(409, { error: STALE_DASHBOARD_MESSAGE }))).toEqual({ ok: false, error: STALE_DASHBOARD_MESSAGE, stale: true });
    expect(await requestRemoveHeldBack('view', 'v1', 4, answer(409, { error: STALE_VIEW_MESSAGE }))).toEqual({ ok: false, error: STALE_VIEW_MESSAGE, stale: true });
    expect(await requestRemoveHeldBack('dashboard', 'd1', 4, answer(403, {}))).toEqual({ ok: false, error: 'Your access does not let you change this dashboard.' });
    expect(await requestRemoveHeldBack('view', 'v1', 4, answer(404, {}))).toEqual({ ok: false, error: 'This saved view no longer exists.' });
  });

  it('never shows a server error it was not meant to, nor a thrown one', async () => {
    expect(await requestRemoveHeldBack('dashboard', 'd1', 4, answer(500, { error: 'tenant 123' }))).toEqual({ ok: false, error: 'The change could not be saved. Try again.' });
    const thrown = vi.fn(async () => { throw new Error('offline'); });
    expect((await requestRemoveHeldBack('dashboard', 'd1', 4, thrown as unknown as typeof fetch)).ok).toBe(false);
  });
});
