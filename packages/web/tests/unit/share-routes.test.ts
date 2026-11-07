/**
 * Sharing (#357, ADR 0012): the owner of a Personal dashboard or saved view shares it with everyone on the
 * install, and a Shared one is unshared by its owner or by someone who manages Shared items. Written through
 * the real routes, repository and audit log. What the contract promises: who may, which names clash and
 * where, what an unshare by someone else never reveals, the revision, and what the audit log holds.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDashboards, execRaw, resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { listAllAuditEntries } from '@/lib/db/audit';
import { getDashboard, setDefaultDashboard } from '@/lib/db/dashboards';
import { getSavedView } from '@/lib/db/saved-views';
import { deleteAssignmentsOn } from '@/lib/db/role-assignments';
import { inTransaction } from '@/lib/db/exec';
import type { Role } from '@/lib/rbac';
import type { Dashboard, WidgetDef } from '@/lib/types';
import type { SavedView } from '@/lib/saved-view-query';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const dashboardsRoute = await import('@/app/api/dashboards/route');
const dashboardRoute = await import('@/app/api/dashboards/[id]/route');
const dashboardShare = await import('@/app/api/dashboards/[id]/share/route');
const dashboardUnshare = await import('@/app/api/dashboards/[id]/unshare/route');
const viewsRoute = await import('@/app/api/views/route');
const viewRoute = await import('@/app/api/views/[id]/route');
const viewShare = await import('@/app/api/views/[id]/share/route');
const viewUnshare = await import('@/app/api/views/[id]/unshare/route');

async function signInAs(role: Role, options: { noScope?: boolean } = {}): Promise<string> {
  const result = await createUser({ email: `${role}-${Math.random().toString(36).slice(2)}@example.com`, role });
  if ('error' in result) throw new Error(result.error);
  await setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
  if (options.noScope) await inTransaction(tx => deleteAssignmentsOn(tx, result.user.id));
  mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
  return result.user.id;
}
const actAs = (id: string) => mockAuth.mockResolvedValue({ user: { uid: id } });

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const body = (method: string, payload: unknown) =>
  new Request('http://localhost/api/x', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
const empty = () => new Request('http://localhost/api/x', { method: 'POST' });

/** The same checks run against both kinds of item, so each kind supplies its own way to make and call one. */
interface Kind {
  label: 'dashboard' | 'view';
  create: (name: string) => Promise<{ id: string; name: string; revision: number }>;
  share: (id: string) => Promise<Response>;
  unshare: (id: string) => Promise<Response>;
  rename: (id: string, name: string) => Promise<Response>;
  stored: (id: string) => Promise<{ name: string; visibility: string; revision: number; ownerId: string | null } | null>;
  nameTaken: (name: string) => string;
  entity: 'dashboard' | 'saved_view';
  table: 'dashboards' | 'saved_views';
}

const dashboards: Kind = {
  label: 'dashboard',
  create: async name => {
    const res = await dashboardsRoute.POST(body('POST', { name }));
    expect(res.status).toBe(201);
    return await res.json() as Dashboard;
  },
  share: id => dashboardShare.POST(empty(), ctx(id)),
  unshare: id => dashboardUnshare.POST(empty(), ctx(id)),
  rename: (id, name) => dashboardRoute.PUT(body('PUT', { name }), ctx(id)),
  stored: async id => {
    const d = await getDashboard(id);
    return d && { name: d.name, visibility: d.visibility, revision: d.revision, ownerId: d.owner?.id ?? null };
  },
  nameTaken: name => `A dashboard named "${name}" already exists.`,
  entity: 'dashboard',
  table: 'dashboards',
};

const views: Kind = {
  label: 'view',
  create: async name => {
    const res = await viewsRoute.POST(body('POST', { name, tab: 'results', query: 'severity=critical' }));
    expect(res.status).toBe(201);
    return await res.json() as SavedView;
  },
  share: id => viewShare.POST(empty(), ctx(id)),
  unshare: id => viewUnshare.POST(empty(), ctx(id)),
  rename: (id, name) => viewRoute.PATCH(body('PATCH', { name }), ctx(id)),
  stored: async id => {
    const v = await getSavedView(id);
    return v && { name: v.name, visibility: v.visibility, revision: v.revision, ownerId: v.owner?.id ?? null };
  },
  nameTaken: name => `A saved view named "${name}" already exists.`,
  entity: 'saved_view',
  table: 'saved_views',
};

const auditOf = async (kind: Kind) => (await listAllAuditEntries()).filter(e => e.entityType === kind.entity);

beforeEach(async () => {
  await resetDb();
  await clearDashboards();
  mockAuth.mockReset();
});

for (const kind of [dashboards, views]) {
  describe(`sharing a ${kind.label}`, () => {
    it('makes the owner\'s Personal item Shared, moves its revision on by one, and shows it to everyone', async () => {
      const owner = await signInAs('editor');
      const made = await kind.create('Team numbers');
      const res = await kind.share(made.id);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: made.id, name: 'Team numbers', visibility: 'shared', revision: made.revision + 1, owner: { id: owner } });
      expect(await kind.stored(made.id)).toMatchObject({ visibility: 'shared', ownerId: owner, revision: made.revision + 1 });

      await signInAs('viewer');
      const list = kind.label === 'dashboard' ? await dashboardsRoute.GET() : await viewsRoute.GET();
      expect((await list.json() as { name: string }[]).map(i => i.name)).toEqual(['Team numbers']);
    });

    it('is refused for a Viewer and for an Editor with no Scope, who keep their Personal item', async () => {
      for (const actor of [() => signInAs('viewer'), () => signInAs('editor', { noScope: true })]) {
        await actor();
        const made = await kind.create(`Mine ${Math.random()}`);
        expect((await kind.share(made.id)).status).toBe(403);
        expect(await kind.stored(made.id)).toMatchObject({ visibility: 'personal', revision: made.revision });
      }
    });

    it('answers someone else\'s Personal item like an unknown id, an Admin included', async () => {
      await signInAs('editor');
      const theirs = await kind.create('Theirs');
      await signInAs('admin');
      const unknown = [await kind.share('nope'), await kind.unshare('nope')];
      const stranger = [await kind.share(theirs.id), await kind.unshare(theirs.id)];
      expect(stranger.map(r => r.status)).toEqual([404, 404]);
      expect(await Promise.all(stranger.map(r => r.json()))).toEqual(await Promise.all(unknown.map(r => r.json())));
      expect(await kind.stored(theirs.id)).toMatchObject({ visibility: 'personal' });
    });

    it('is the owner\'s call alone: an Admin cannot share an item someone else owns', async () => {
      await signInAs('editor');
      const made = await kind.create('Team numbers');
      await kind.share(made.id);
      await signInAs('admin');
      expect((await kind.share(made.id)).status).toBe(403);
    });

    it('answers 409 with a reload message when the item is already Shared, and changes nothing', async () => {
      await signInAs('editor');
      const made = await kind.create('Team numbers');
      expect((await kind.share(made.id)).status).toBe(200);
      const again = await kind.share(made.id);
      expect(again.status).toBe(409);
      expect((await again.json()).error).toMatch(/reload/i);
      expect(await kind.stored(made.id)).toMatchObject({ revision: made.revision + 1 });
      expect((await auditOf(kind)).filter(e => e.action.endsWith('.share'))).toHaveLength(1);
    });

    it('checks Shared names install-wide, whatever their case, and 409s with name-taken', async () => {
      await signInAs('editor');
      const first = await kind.create('Overview');
      await kind.share(first.id);

      await signInAs('editor');
      const second = await kind.create('overview');
      const res = await kind.share(second.id);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe(kind.nameTaken('overview'));
      expect(await kind.stored(second.id)).toMatchObject({ visibility: 'personal', revision: second.revision });
    });

    it('does not clash with another person\'s Personal names', async () => {
      await signInAs('editor');
      await kind.create('Overview');
      await signInAs('editor');
      const mine = await kind.create('Overview');
      expect((await kind.share(mine.id)).status).toBe(200);
    });

    it('checks the Shared names when a Shared item is renamed', async () => {
      const owner = await signInAs('editor');
      const a = await kind.create('Alpha');
      const b = await kind.create('Beta');
      await kind.share(a.id);
      await kind.share(b.id);
      expect((await kind.rename(a.id, ' BETA')).status).toBe(409);

      await signInAs('editor');
      await kind.create('Gamma');
      actAs(owner);
      expect((await kind.rename(a.id, 'gamma')).status).toBe(200);
    });

    it('logs the share with the item\'s name', async () => {
      await signInAs('editor');
      const made = await kind.create('Team numbers');
      await kind.share(made.id);
      const entry = (await auditOf(kind)).find(e => e.action === `${kind.label === 'view' ? 'view' : 'dashboard'}.share`);
      expect(entry).toMatchObject({ entityId: made.id });
      expect(entry?.summary).toContain('Team numbers');
    });
  });

  describe(`unsharing a ${kind.label}`, () => {
    it('lets the owner make it Personal again, moves the revision on, and hides it from everyone else', async () => {
      const owner = await signInAs('editor');
      const made = await kind.create('Team numbers');
      await kind.share(made.id);
      const res = await kind.unshare(made.id);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: made.id, name: 'Team numbers', visibility: 'personal', owner: { id: owner }, revision: made.revision + 2 });

      await signInAs('viewer');
      const list = kind.label === 'dashboard' ? await dashboardsRoute.GET() : await viewsRoute.GET();
      expect(await list.json()).toEqual([]);
    });

    it('is refused for the owner who clashes with one of their own Personal names, leaving it Shared', async () => {
      await signInAs('editor');
      const shared = await kind.create('Overview');
      await kind.share(shared.id);
      await kind.create('overview');
      const res = await kind.unshare(shared.id);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe(kind.nameTaken('Overview'));
      expect(await kind.stored(shared.id)).toMatchObject({ visibility: 'shared', name: 'Overview', revision: shared.revision + 1 });
    });

    it('by someone else gives it the next free name among the owner\'s Personal names, and does not return it', async () => {
      const owner = await signInAs('editor');
      const shared = await kind.create('Overview');
      await kind.share(shared.id);
      await kind.create('Overview');
      await kind.create('Overview (2)');

      await signInAs('admin');
      const res = await kind.unshare(shared.id);
      expect(res.status).toBe(200);
      expect(JSON.stringify(await res.json())).not.toContain('Overview');
      expect(await kind.stored(shared.id)).toMatchObject({ visibility: 'personal', name: 'Overview (3)', ownerId: owner, revision: shared.revision + 2 });
    });

    it('by someone else never fails on a clash and keeps the name when it is free', async () => {
      await signInAs('editor');
      const shared = await kind.create('Overview');
      await kind.share(shared.id);
      await signInAs('admin');
      expect((await kind.unshare(shared.id)).status).toBe(200);
      expect(await kind.stored(shared.id)).toMatchObject({ visibility: 'personal', name: 'Overview' });
    });

    it('is refused with 409 "Take this over before unsharing it" for an item with no owner', async () => {
      await signInAs('editor');
      const made = await kind.create('Orphan');
      await kind.share(made.id);
      await execRaw(`UPDATE ${kind.table} SET owner_id = NULL WHERE id = '${made.id}'`);
      await signInAs('admin');
      const res = await kind.unshare(made.id);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe('Take this over before unsharing it');
      expect(await kind.stored(made.id)).toMatchObject({ visibility: 'shared' });
    });

    it('needs the owner or someone who manages Shared items: a scoped Editor and a Viewer who is not the owner get 403', async () => {
      await signInAs('editor');
      const made = await kind.create('Team numbers');
      await kind.share(made.id);
      await signInAs('viewer');
      expect((await kind.unshare(made.id)).status).toBe(403);
      await signInAs('editor', { noScope: true });
      expect((await kind.unshare(made.id)).status).toBe(403);
      expect(await kind.stored(made.id)).toMatchObject({ visibility: 'shared' });
    });

    it('answers 409 with a reload message when the item is already Personal', async () => {
      await signInAs('editor');
      const made = await kind.create('Mine');
      const res = await kind.unshare(made.id);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/reload/i);
      expect(await kind.stored(made.id)).toMatchObject({ visibility: 'personal', revision: made.revision });
    });

    it('logs the unshare with the name the item had while Shared, even when someone else renamed it for the owner', async () => {
      await signInAs('editor');
      const shared = await kind.create('Overview');
      await kind.share(shared.id);
      await kind.create('Overview');
      await signInAs('admin');
      await kind.unshare(shared.id);

      const entries = await auditOf(kind);
      const entry = entries.find(e => e.action.endsWith('.unshare'));
      expect(entry).toMatchObject({ entityId: shared.id });
      expect(entry?.summary).toContain('"Overview"');
      expect(JSON.stringify(entries.map(e => [e.summary, e.details]))).not.toContain('Overview (2)');
    });
  });
}

describe('unsharing the Install default', () => {
  it('leaves the install with no default, since the default has to be Shared', async () => {
    await signInAs('admin');
    const made = await dashboards.create('Home');
    await dashboards.share(made.id);
    await setDefaultDashboard(made.id);
    expect((await getDashboard(made.id))?.isDefault).toBe(true);
    expect((await dashboards.unshare(made.id)).status).toBe(200);
    expect((await getDashboard(made.id))?.isDefault).toBe(false);
  });
});

describe('saving a Shared dashboard writes one audit entry with the changed field names', () => {
  const widget = (id: string, over: Partial<WidgetDef> = {}): WidgetDef =>
    ({ id, type: 'stat-card', title: 'Open findings', x: 0, y: 0, w: 4, h: 2, config: {}, ...over });
  const save = (id: string, config: Dashboard['config'], extra: Record<string, unknown> = {}) =>
    dashboardRoute.PUT(body('PUT', { config, ...extra }), ctx(id));
  // Rows written in the same millisecond have no defined order, so each save looks up what it added.
  const seen = new Set<string>();
  const added = async () => {
    const fresh = (await auditOf(dashboards)).filter(e => !seen.has(e.id));
    for (const e of fresh) seen.add(e.id);
    return fresh;
  };

  async function sharedWith(config: Dashboard['config']): Promise<string> {
    await signInAs('editor');
    const res = await dashboardsRoute.POST(body('POST', { name: 'Team numbers', config }));
    const made = await res.json() as Dashboard;
    await dashboards.share(made.id);
    return made.id;
  }

  it('names layout when widgets only moved, widgets when one changed, and filters when the filter bar changed', async () => {
    const id = await sharedWith({ autoRefresh: 0, widgets: [widget('a'), widget('b', { y: 2 })] });

    await added();

    expect((await save(id, { autoRefresh: 0, widgets: [widget('a', { x: 4 }), widget('b', { y: 2 })] })).status).toBe(200);
    expect((await added()).map(e => [e.action, e.details])).toEqual([['dashboard.update', { fields: ['layout'] }]]);

    await save(id, { autoRefresh: 0, widgets: [widget('a', { x: 4, title: 'Renamed widget' }), widget('b', { y: 2 })] });
    expect((await added()).map(e => e.details)).toEqual([{ fields: ['widgets'] }]);

    await save(id, { autoRefresh: 0, widgets: [widget('a', { x: 5, title: 'Renamed widget' }), widget('b', { y: 2 })], filters: { severities: ['high'] } });
    expect((await added()).map(e => e.details)).toEqual([{ fields: ['filters', 'layout'] }]);
  });

  it('names name and description, logs the item\'s name, and never a value', async () => {
    const id = await sharedWith({ autoRefresh: 0, widgets: [widget('a')] });
    await added();
    await dashboardRoute.PUT(body('PUT', { name: 'Secret new name', description: 'A secret description' }), ctx(id));
    const [entry, ...rest] = await added();
    expect(rest).toEqual([]);
    expect(entry?.details).toEqual({ fields: ['name', 'description'] });
    expect(entry?.summary).toContain('Team numbers');
    expect(JSON.stringify(entry?.details)).not.toContain('secret');
  });

  it('writes nothing when a save changes nothing', async () => {
    const config = { autoRefresh: 0, widgets: [widget('a')] };
    const id = await sharedWith(config);
    await added();
    expect((await save(id, config, { name: 'Team numbers' })).status).toBe(200);
    expect(await added()).toEqual([]);
  });

  it('writes nothing for a Personal dashboard\'s save, only for its rename (by id and kind)', async () => {
    await signInAs('editor');
    const res = await dashboardsRoute.POST(body('POST', { name: 'Mine', config: { autoRefresh: 0, widgets: [widget('a')] } }));
    const made = await res.json() as Dashboard;
    const before = (await auditOf(dashboards)).length;
    await save(made.id, { autoRefresh: 0, widgets: [widget('a', { x: 3 })] });
    expect((await auditOf(dashboards)).length).toBe(before);
  });
});

describe('saving a Shared view', () => {
  const patch = (id: string, payload: unknown) => viewRoute.PATCH(body('PATCH', payload), ctx(id));

  it('writes view.update with the field names, view.rename for a rename alone, and nothing when nothing changed', async () => {
    await signInAs('editor');
    const made = await views.create('Critical only');
    await views.share(made.id);
    const count = async () => (await auditOf(views)).filter(e => !e.action.endsWith('.share')).length;
    const before = await count();

    await patch(made.id, { query: 'severity=high', tab: 'advisories' });
    await patch(made.id, { name: 'High only' });
    await patch(made.id, { name: 'High only', query: 'severity=high' });

    const entries = (await auditOf(views)).filter(e => !e.action.endsWith('.share'));
    expect(entries.length - before).toBe(2);
    expect(entries.find(e => e.action === 'view.update')?.details).toEqual({ fields: ['tab', 'query'] });
    expect(entries.find(e => e.action === 'view.rename')?.details).toEqual({ fields: ['name'] });
    expect(entries.find(e => e.action === 'view.update')?.summary).toContain('Critical only');
  });

  it('is refused for a demoted owner, who can neither change nor unshare it', async () => {
    const owner = await signInAs('editor');
    const made = await views.create('Mine');
    await views.share(made.id);
    await execRaw(`UPDATE users SET role = 'viewer' WHERE id = '${owner}'`);
    await inTransaction(tx => deleteAssignmentsOn(tx, owner));
    expect((await patch(made.id, { name: 'Still mine?' })).status).toBe(403);
    expect((await views.unshare(made.id)).status).toBe(403);
  });
});
