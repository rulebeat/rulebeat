/**
 * PUT /api/dashboards/[id]/filters (ADR 0013): the explicit, revision-checked, audited save of a
 * dashboard's saved filters. Fixture: the dashboard saves Subscription {A, B} and Severity critical.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createUser } from '@/lib/db/users';
import { createDashboard, getDashboard, updateDashboard } from '@/lib/db/dashboards';
import { listAuditEntries } from '@/lib/db/audit';
import { replaceAssignmentsOn } from '@/lib/db/role-assignments';
import { inTransaction } from '@/lib/db/exec';
import type { WidgetDef } from '@/lib/types';
import { VIEWER_DASHBOARD_REASON } from '@/lib/write-controls';
import { resetDb } from '../helpers/db';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

// The per-item edit right is the ownership spec's to widen (a Viewer on their own Personal item). Until
// it lands, a test that needs a person who holds only part of the Scope to hold it says so here.
let grantEdit = false;
vi.mock('@/lib/rbac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/rbac')>('@/lib/rbac');
  return { ...actual, mayAct: (access: Parameters<typeof actual.mayAct>[0], action: Parameters<typeof actual.mayAct>[1]) => (grantEdit && action === 'dashboards:write') || actual.mayAct(access, action) };
});

const { PUT } = await import('@/app/api/dashboards/[id]/filters/route');

const SUB_A = '00000000-0000-0000-0000-00000000000a';
const SUB_B = '00000000-0000-0000-0000-00000000000b';
const widget = (id: string): WidgetDef => ({ id, type: 'stat-card', title: id, x: 0, y: 0, w: 4, h: 4, config: {} }) as WidgetDef;

let id: string;
let admin: string;
beforeEach(async () => {
  await resetDb();
  grantEdit = false;
  const created = await createUser({ email: 'admin@example.com', role: 'admin' });
  if ('error' in created) throw new Error(created.error);
  admin = created.user.id;
  mockAuth.mockResolvedValue({ user: { uid: admin } });
  const dashboard = await createDashboard({
    name: `filters ${crypto.randomUUID()}`,
    config: { widgets: [widget('a')], filters: { subscriptions: [SUB_A, SUB_B], severities: ['critical'] }, dateWindow: { mode: 'relative', days: 30 } },
  });
  if (!dashboard.ok) throw new Error(dashboard.reason);
  id = dashboard.dashboard.id;
});

const put = (body: unknown, target = id) => PUT(
  new Request(`http://localhost/api/dashboards/${target}/filters`, { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
  { params: Promise.resolve({ id: target }) },
);
const revision = async () => (await getDashboard(id))!.revision;
const saveEntries = async () => (await listAuditEntries()).filter(e => e.action === 'dashboard.filters_save');

describe('a save by someone with the edit right', () => {
  it('writes the filters, returns the new revision and the bar, and audits the dimension names only', async () => {
    const before = await revision();
    const res = await put({ revision: before, changes: { severity: ['high'], window: { mode: 'relative', days: 7 } } });
    expect(res.status).toBe(200);
    const body = await res.json() as { revision: number; bar: { revision: number; dimensions: { severity: { effective: string[]; changed: boolean } } } };
    expect(body.revision).toBe(before + 1);
    expect(body.bar.revision).toBe(before + 1);
    expect(body.bar.dimensions.severity).toMatchObject({ effective: ['high'], changed: false });
    expect((await getDashboard(id))!.config.filters?.severities).toEqual(['high']);

    const entries = await saveEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ summary: "Saved this dashboard's filters", entityType: 'dashboard', entityId: id, actorId: admin });
    expect(entries[0]!.details).toEqual({ dimensions: ['severity', 'window'], revision: before + 1 });
    expect(JSON.stringify(entries[0])).not.toContain('high');
  });

  it('leaves the widgets and the layout as stored', async () => {
    await put({ revision: await revision(), changes: { category: ['cost'] } });
    expect((await getDashboard(id))!.config.widgets).toEqual([widget('a')]);
  });

  it('writes no audit entry when nothing differs from what is saved', async () => {
    const before = await revision();
    const res = await put({ revision: before, changes: { severity: ['critical'] } });
    expect(res.status).toBe(200);
    expect(await saveEntries()).toHaveLength(0);
    expect(await revision()).toBe(before);
  });

  it('answers a stale revision with 409 and writes nothing', async () => {
    const stale = await revision();
    await updateDashboard(id, { name: `renamed ${crypto.randomUUID()}` });
    const current = await revision();
    const res = await put({ revision: stale, changes: { severity: ['high'] } });
    expect(res.status).toBe(409);
    expect((await res.json() as { revision: number }).revision).toBe(current);
    expect((await getDashboard(id))!.config.filters?.severities).toEqual(['critical']);
    expect(await saveEntries()).toHaveLength(0);
  });

  it('names who saved the filters meanwhile and when, and returns the bar of the newer revision', async () => {
    const stale = await revision();
    const sam = await createUser({ email: 'sam@example.com', name: 'Sam Rivera', role: 'admin' });
    if ('error' in sam) throw new Error(sam.error);
    mockAuth.mockResolvedValue({ user: { uid: sam.user.id } });
    expect((await put({ revision: stale, changes: { severity: ['low'], tags: ['prod'] } })).status).toBe(200);
    mockAuth.mockResolvedValue({ user: { uid: admin } });

    const res = await put({ revision: stale, changes: { severity: ['high'] } });
    expect(res.status).toBe(409);
    const body = await res.json() as { revision: number; changedBy: string; changedAt: string; bar: { revision: number; dimensions: Record<string, { effective: string[]; inUrl: boolean }> } };
    expect(body.changedBy).toBe('Sam Rivera');
    expect(Date.parse(body.changedAt)).not.toBeNaN();
    expect(body.bar.revision).toBe(await revision());
    expect(body.bar.dimensions['tags']!.effective).toEqual(['prod']);
    expect(body.bar.dimensions['severity']).toMatchObject({ effective: ['high'], inUrl: true });
    expect((await getDashboard(id))!.config.filters?.severities).toEqual(['low']);
  });

  it('names the person by email when they have no display name', async () => {
    const stale = await revision();
    expect((await put({ revision: stale, changes: { severity: ['low'] } })).status).toBe(200);
    const res = await put({ revision: stale, changes: { severity: ['high'] } });
    expect((await res.json() as { changedBy: string }).changedBy).toBe('admin@example.com');
  });

  it('names nobody when the revision moved by a rename and the saved filters did not', async () => {
    const stale = await revision();
    await updateDashboard(id, { name: `renamed ${crypto.randomUUID()}` });
    const res = await put({ revision: stale, changes: { severity: ['high'] } });
    expect(res.status).toBe(409);
    const body = await res.json() as Record<string, unknown>;
    expect(body['changedBy']).toBeUndefined();
    expect(body['changedAt']).toBeUndefined();
    expect(body['bar']).toBeDefined();
  });

  it('names nobody when the filters were saved before the page was opened and only a rename came after', async () => {
    const sam = await createUser({ email: 'sam@example.com', name: 'Sam Rivera', role: 'admin' });
    if ('error' in sam) throw new Error(sam.error);
    mockAuth.mockResolvedValue({ user: { uid: sam.user.id } });
    expect((await put({ revision: await revision(), changes: { severity: ['low'] } })).status).toBe(200);
    mockAuth.mockResolvedValue({ user: { uid: admin } });

    const opened = await revision();
    await updateDashboard(id, { name: `renamed ${crypto.randomUUID()}` });
    const res = await put({ revision: opened, changes: { severity: ['high'] } });
    expect(res.status).toBe(409);
    const body = await res.json() as Record<string, unknown>;
    expect(body['changedBy']).toBeUndefined();
    expect(body['changedAt']).toBeUndefined();
  });

  it('answers an unknown dashboard with 404', async () => {
    expect((await put({ revision: 1, changes: {} }, 'nope')).status).toBe(404);
  });

  it.each([
    ['no revision', { changes: {} }],
    ['a revision that is not a number', { revision: '1', changes: {} }],
    ['changes that are not an object', { revision: 1, changes: [] }],
    ['a dimension that does not exist', { revision: 1, changes: { colour: ['red'] } }],
    ['a list that holds a number', { revision: 1, changes: { tags: [1] } }],
    ['a severity that does not exist', { revision: 1, changes: { severity: ['urgent'] } }],
    ['a malformed window', { revision: 1, changes: { window: { mode: 'relative', days: 0 } } }],
  ])('answers %s with 400', async (_name, body) => {
    expect((await put(body)).status).toBe(400);
  });
});

describe('a save by someone without the edit right', () => {
  it('is refused, and writes nothing', async () => {
    const viewer = await createUser({ email: 'viewer@example.com', role: 'viewer' });
    if ('error' in viewer) throw new Error(viewer.error);
    mockAuth.mockResolvedValue({ user: { uid: viewer.user.id } });
    const res = await put({ revision: await revision(), changes: { severity: ['high'] } });
    expect(res.status).toBe(403);
    expect((await res.json() as { reason: string }).reason).toBe(VIEWER_DASHBOARD_REASON);
    expect((await getDashboard(id))!.config.filters?.severities).toEqual(['critical']);
    expect(await saveEntries()).toHaveLength(0);
  });
});

describe('a save by someone who holds only part of the saved Scope', () => {
  beforeEach(async () => {
    grantEdit = true;
    const l = await createUser({ email: 'l@example.com', role: 'editor' });
    if ('error' in l) throw new Error(l.error);
    await inTransaction(tx => replaceAssignmentsOn(tx, l.user.id, [
      { tenantId: 't', scope: `/subscriptions/${SUB_B}`, role: 'editor' },
    ]));
    mockAuth.mockResolvedValue({ user: { uid: l.user.id } });
  });

  it('refuses a value outside their access with the count, and writes nothing', async () => {
    const before = await revision();
    const res = await put({ revision: before, changes: { subscription: [SUB_A, SUB_B] } });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'outside-access', count: 1 });
    expect(await revision()).toBe(before);
    expect(await saveEntries()).toHaveLength(0);
  });

  it('refuses any over saved values they do not hold', async () => {
    const res = await put({ revision: await revision(), changes: { subscription: [] } });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'any-over-held-back', dimensions: ['subscription'] });
    expect((await getDashboard(id))!.config.filters?.subscriptions).toEqual([SUB_A, SUB_B]);
  });

  it('keeps what they cannot see when they narrow another dimension', async () => {
    const res = await put({ revision: await revision(), changes: { severity: ['high'] } });
    expect(res.status).toBe(200);
    expect((await getDashboard(id))!.config.filters?.subscriptions).toEqual([SUB_A, SUB_B]);
  });
});
