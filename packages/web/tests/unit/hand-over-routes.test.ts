/**
 * Hand over and take over (#367, ADR 0012): the owner of a Shared dashboard or saved view hands it to another
 * eligible person, and someone who manages Shared items takes any of them over, an ownerless one included.
 * Written through the real routes, repository and audit log. What the contract promises: who may, who is
 * offered, what changes and what does not, what a stale call gets, and what the audit log holds.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDashboards, execRaw, resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { listAllAuditEntries } from '@/lib/db/audit';
import { getDashboard, setDefaultDashboard, transferDashboard } from '@/lib/db/dashboards';
import { getSavedView, transferSavedView } from '@/lib/db/saved-views';
import type { Role } from '@/lib/rbac';
import type { Dashboard } from '@/lib/types';
import type { SavedView } from '@/lib/saved-view-query';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const dashboardsRoute = await import('@/app/api/dashboards/route');
const dashboardShare = await import('@/app/api/dashboards/[id]/share/route');
const dashboardCandidates = await import('@/app/api/dashboards/[id]/hand-over-candidates/route');
const dashboardHandOver = await import('@/app/api/dashboards/[id]/hand-over/route');
const dashboardTakeOver = await import('@/app/api/dashboards/[id]/take-over/route');
const viewsRoute = await import('@/app/api/views/route');
const viewShare = await import('@/app/api/views/[id]/share/route');
const viewCandidates = await import('@/app/api/views/[id]/hand-over-candidates/route');
const viewHandOver = await import('@/app/api/views/[id]/hand-over/route');
const viewTakeOver = await import('@/app/api/views/[id]/take-over/route');

const SUB_SCOPE = '/subscriptions/00000000-0000-0000-0000-000000000001';
const TENANT = '00000000-0000-0000-0000-0000000000aa';

interface Person { id: string; email: string }

/** Makes a person and signs in as them. `scoped` gives them one subscription instead of Everything, `noScope` nothing. */
async function signInAs(role: Role, options: { scoped?: boolean; noScope?: boolean; name?: string } = {}): Promise<Person> {
  const email = `${role}-${Math.random().toString(36).slice(2)}@example.com`;
  const access = options.noScope ? [] : options.scoped ? [{ tenantId: TENANT, scope: SUB_SCOPE, role }] : undefined;
  const result = await createUser({ email, role, name: options.name, access });
  if ('error' in result) throw new Error(result.error);
  await setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
  mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
  return { id: result.user.id, email };
}
const actAs = (person: Person) => mockAuth.mockResolvedValue({ user: { uid: person.id } });

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (payload?: unknown) => new Request('http://localhost/api/x', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
});
const get = () => new Request('http://localhost/api/x');

/** The same checks run against both kinds of item, so each kind supplies its own way to make and call one. */
interface Kind {
  label: 'dashboard' | 'view';
  /** A Personal item for the person signed in. */
  create: (name: string) => Promise<{ id: string; name: string; revision: number }>;
  share: (id: string) => Promise<Response>;
  candidates: (id: string) => Promise<Response>;
  handOver: (id: string, userId: unknown) => Promise<Response>;
  takeOver: (id: string) => Promise<Response>;
  stored: (id: string) => Promise<{ name: string; visibility: string; revision: number; ownerId: string | null; content: unknown } | null>;
  noun: string;
  table: 'dashboards' | 'saved_views';
  entity: 'dashboard' | 'saved_view';
}

const dashboards: Kind = {
  label: 'dashboard',
  create: async name => {
    // Stored filter values that some viewers hold back: the hand-over must leave them exactly as they are.
    const config = { autoRefresh: 0, widgets: [], filters: { subscriptions: ['00000000-0000-0000-0000-000000000009'] } };
    const res = await dashboardsRoute.POST(post({ name, config }));
    expect(res.status).toBe(201);
    return await res.json() as Dashboard;
  },
  share: id => dashboardShare.POST(post(), ctx(id)),
  candidates: id => dashboardCandidates.GET(get(), ctx(id)),
  handOver: (id, userId) => dashboardHandOver.POST(post({ userId }), ctx(id)),
  takeOver: id => dashboardTakeOver.POST(post(), ctx(id)),
  stored: async id => {
    const d = await getDashboard(id);
    return d && { name: d.name, visibility: d.visibility, revision: d.revision, ownerId: d.owner?.id ?? null, content: d.config };
  },
  noun: 'dashboard',
  table: 'dashboards',
  entity: 'dashboard',
};

const views: Kind = {
  label: 'view',
  create: async name => {
    const res = await viewsRoute.POST(post({ name, tab: 'results', query: 'subscription=hidden-one&severity=critical' }));
    expect(res.status).toBe(201);
    return await res.json() as SavedView;
  },
  share: id => viewShare.POST(post(), ctx(id)),
  candidates: id => viewCandidates.GET(get(), ctx(id)),
  handOver: (id, userId) => viewHandOver.POST(post({ userId }), ctx(id)),
  takeOver: id => viewTakeOver.POST(post(), ctx(id)),
  stored: async id => {
    const v = await getSavedView(id);
    return v && { name: v.name, visibility: v.visibility, revision: v.revision, ownerId: v.owner?.id ?? null, content: v.query };
  },
  noun: 'saved view',
  table: 'saved_views',
  entity: 'saved_view',
};

const auditOf = async (kind: Kind, suffix: string) =>
  (await listAllAuditEntries()).filter(e => e.entityType === kind.entity && e.action === `${kind.label}.${suffix}`);

/** A Shared item owned by `owner`, who is signed in when it is made. */
async function sharedBy(kind: Kind, owner: Person, name = 'Team numbers') {
  actAs(owner);
  const made = await kind.create(name);
  expect((await kind.share(made.id)).status).toBe(200);
  return { ...made, revision: made.revision + 1 };
}

beforeEach(async () => {
  await resetDb();
  await clearDashboards();
  mockAuth.mockReset();
});

for (const kind of [dashboards, views]) {
  describe(`the people a ${kind.label} can be handed to`, () => {
    it('lists Admins and people with an Editor Role at any Scope, with only id, display name and email, and not the owner', async () => {
      const owner = await signInAs('editor');
      const shared = await sharedBy(kind, owner);
      const scoped = await signInAs('editor', { scoped: true, name: 'Sam Scoped' });
      const everything = await signInAs('editor');
      const admin = await signInAs('admin', { name: 'Ada Admin' });
      await signInAs('viewer');
      await signInAs('editor', { noScope: true });

      actAs(owner);
      const res = await kind.candidates(shared.id);
      expect(res.status).toBe(200);
      const list = await res.json() as unknown[];
      expect(list).toEqual(expect.arrayContaining([
        { id: scoped.id, displayName: 'Sam Scoped', email: scoped.email },
        { id: everything.id, displayName: everything.email, email: everything.email },
        { id: admin.id, displayName: 'Ada Admin', email: admin.email },
      ]));
      expect(list).toHaveLength(3);
    });

    it('is shown to the owner, to an Admin and to an Editor on Everything, and to no one else', async () => {
      const owner = await signInAs('editor', { scoped: true });
      const shared = await sharedBy(kind, owner);

      actAs(owner);
      expect((await kind.candidates(shared.id)).status).toBe(200);
      await signInAs('admin');
      expect((await kind.candidates(shared.id)).status).toBe(200);
      await signInAs('editor');
      expect((await kind.candidates(shared.id)).status).toBe(200);

      await signInAs('editor', { scoped: true });
      expect((await kind.candidates(shared.id)).status).toBe(403);
      await signInAs('viewer');
      expect((await kind.candidates(shared.id)).status).toBe(403);
    });

    it('answers someone else\'s Personal item like an unknown id, and 409 for the owner\'s own Personal item', async () => {
      const owner = await signInAs('editor');
      const personal = await kind.create('Mine');
      await signInAs('admin');
      const stranger = await kind.candidates(personal.id);
      const unknown = await kind.candidates('nope');
      expect(stranger.status).toBe(404);
      expect(await stranger.json()).toEqual(await unknown.json());

      actAs(owner);
      expect((await kind.candidates(personal.id)).status).toBe(409);
    });

    it('does not offer the current owner and, for an item with no owner, offers everyone eligible', async () => {
      const owner = await signInAs('editor');
      const shared = await sharedBy(kind, owner);
      await execRaw(`UPDATE ${kind.table} SET owner_id = NULL WHERE id = '${shared.id}'`);
      const admin = await signInAs('admin');
      const ids = ((await (await kind.candidates(shared.id)).json()) as { id: string }[]).map(c => c.id);
      expect(ids).toContain(owner.id);
      expect(ids).toContain(admin.id);
    });
  });

  describe(`handing over a ${kind.label}`, () => {
    it('moves it to the chosen person, keeps it Shared with its content, moves the revision on by one and tells no one', async () => {
      const owner = await signInAs('editor');
      const shared = await sharedBy(kind, owner);
      const before = await kind.stored(shared.id);
      const next = await signInAs('editor', { scoped: true });
      const auditBefore = (await listAllAuditEntries()).length;

      actAs(owner);
      const res = await kind.handOver(shared.id, next.id);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: shared.id, name: 'Team numbers', visibility: 'shared', revision: shared.revision + 1, owner: { id: next.id } });
      expect(await kind.stored(shared.id)).toEqual({ ...before, ownerId: next.id, revision: shared.revision + 1 });
      // Nobody is notified: the only thing written is the audit entry.
      expect((await listAllAuditEntries()).length).toBe(auditBefore + 1);
    });

    it('lets the new owner change it and takes that away from the old one when they are a scoped Editor', async () => {
      const owner = await signInAs('editor', { scoped: true });
      const shared = await sharedBy(kind, owner);
      const next = await signInAs('editor', { scoped: true });
      actAs(owner);
      expect((await kind.handOver(shared.id, next.id)).status).toBe(200);
      // The old owner no longer owns it, so a second hand-over from them is refused.
      expect((await kind.handOver(shared.id, next.id)).status).toBe(403);
      actAs(next);
      expect((await kind.candidates(shared.id)).status).toBe(200);
    });

    it('lets an Admin and an Editor on Everything hand over an item someone else owns', async () => {
      const owner = await signInAs('editor', { scoped: true });
      const shared = await sharedBy(kind, owner);
      const next = await signInAs('editor', { scoped: true });
      await signInAs('admin');
      expect((await kind.handOver(shared.id, next.id)).status).toBe(200);
      await signInAs('editor');
      expect((await kind.handOver(shared.id, owner.id)).status).toBe(200);
      expect(await kind.stored(shared.id)).toMatchObject({ ownerId: owner.id, revision: shared.revision + 2 });
    });

    it('is refused for a scoped Editor and a Viewer who do not own it, and changes nothing', async () => {
      const owner = await signInAs('editor');
      const shared = await sharedBy(kind, owner);
      const next = await signInAs('editor', { scoped: true });
      for (const actor of [() => signInAs('editor', { scoped: true }), () => signInAs('viewer'), () => signInAs('editor', { noScope: true })]) {
        await actor();
        expect((await kind.handOver(shared.id, next.id)).status).toBe(403);
      }
      expect(await kind.stored(shared.id)).toMatchObject({ ownerId: owner.id, revision: shared.revision });
    });

    it('is refused for an owner whose access no longer lets them change Shared items', async () => {
      const owner = await signInAs('editor');
      const shared = await sharedBy(kind, owner);
      const next = await signInAs('editor');
      await execRaw(`UPDATE users SET role = 'viewer' WHERE id = '${owner.id}'`);
      await execRaw(`DELETE FROM role_assignments WHERE user_id = '${owner.id}'`);
      actAs(owner);
      expect((await kind.handOver(shared.id, next.id)).status).toBe(403);
    });

    it('refuses someone who is not eligible with one generic message, whoever they are, and changes nothing', async () => {
      const owner = await signInAs('editor');
      const shared = await sharedBy(kind, owner);
      const viewer = await signInAs('viewer');
      const noScope = await signInAs('editor', { noScope: true });
      actAs(owner);

      const replies = [];
      for (const target of [viewer.id, noScope.id, owner.id, 'not-a-person', '', null, 42]) {
        const res = await kind.handOver(shared.id, target);
        expect(res.status).toBe(400);
        replies.push(await res.json());
      }
      expect(new Set(replies.map(r => JSON.stringify(r))).size).toBe(1);
      expect(JSON.stringify(replies[0])).not.toContain(viewer.email);
      expect(await kind.stored(shared.id)).toMatchObject({ ownerId: owner.id, revision: shared.revision });
      expect(await auditOf(kind, 'hand_over')).toEqual([]);
    });

    it('refuses a body without a JSON Content-Type with 415, and malformed JSON with 400', async () => {
      const owner = await signInAs('editor');
      const shared = await sharedBy(kind, owner);
      const route = kind.label === 'dashboard' ? dashboardHandOver : viewHandOver;
      const bare = await route.POST(new Request('http://localhost/api/x', { method: 'POST', body: 'nope' }), ctx(shared.id));
      expect(bare.status).toBe(415);
      const form = await route.POST(new Request('http://localhost/api/x', {
        method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ userId: owner.id }),
      }), ctx(shared.id));
      expect(form.status).toBe(415);
      const broken = await route.POST(new Request('http://localhost/api/x', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'nope',
      }), ctx(shared.id));
      expect(broken.status).toBe(400);
      expect(await kind.stored(shared.id)).toMatchObject({ ownerId: owner.id, revision: shared.revision });
    });

    it('is for Shared items only: a Personal item gets 409 for its owner and 404 for anyone else', async () => {
      const owner = await signInAs('editor');
      const personal = await kind.create('Mine');
      const next = await signInAs('editor');
      actAs(owner);
      expect((await kind.handOver(personal.id, next.id)).status).toBe(409);
      expect((await kind.takeOver(personal.id)).status).toBe(409);
      await signInAs('admin');
      expect((await kind.handOver(personal.id, next.id)).status).toBe(404);
      expect((await kind.takeOver(personal.id)).status).toBe(404);
      expect(await kind.stored(personal.id)).toMatchObject({ visibility: 'personal', ownerId: owner.id, revision: personal.revision });
    });

    it('answers 409 with a reload message when the item was unshared since the page loaded', async () => {
      const owner = await signInAs('editor');
      const shared = await sharedBy(kind, owner);
      const next = await signInAs('editor');
      await execRaw(`UPDATE ${kind.table} SET visibility = 'personal' WHERE id = '${shared.id}'`);
      actAs(owner);
      const res = await kind.handOver(shared.id, next.id);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/reload/i);
    });

    it('checks Shared names install-wide: an item that now clashes with another Shared name is refused with 409', async () => {
      const owner = await signInAs('editor');
      const first = await sharedBy(kind, owner, 'Overview');
      const second = await sharedBy(kind, owner, 'Other');
      await execRaw(`UPDATE ${kind.table} SET name = 'overview' WHERE id = '${second.id}'`);
      const next = await signInAs('editor');
      actAs(owner);
      const res = await kind.handOver(second.id, next.id);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe(`A ${kind.noun} named "overview" already exists.`);
      expect(await kind.stored(second.id)).toMatchObject({ ownerId: owner.id, revision: second.revision });
      expect(first.id).not.toBe(second.id);
    });

    it('does not clash with another person\'s Personal names', async () => {
      const owner = await signInAs('editor');
      const shared = await sharedBy(kind, owner, 'Overview');
      const next = await signInAs('editor');
      await kind.create('Overview');
      actAs(owner);
      expect((await kind.handOver(shared.id, next.id)).status).toBe(200);
    });

    it('lets someone who manages Shared items hand an ownerless item straight to an eligible person', async () => {
      const owner = await signInAs('editor');
      const shared = await sharedBy(kind, owner);
      await execRaw(`UPDATE ${kind.table} SET owner_id = NULL WHERE id = '${shared.id}'`);
      const next = await signInAs('editor', { scoped: true });
      await signInAs('admin');
      const res = await kind.handOver(shared.id, next.id);
      expect(res.status).toBe(200);
      expect(await kind.stored(shared.id)).toMatchObject({ ownerId: next.id, visibility: 'shared', revision: shared.revision + 1 });
    });

    it('logs the hand-over naming both people by display name, else email, and nothing else about them', async () => {
      const owner = await signInAs('editor', { name: 'Olive Owner' });
      const shared = await sharedBy(kind, owner);
      const next = await signInAs('editor');
      actAs(owner);
      await kind.handOver(shared.id, next.id);
      const [entry, ...rest] = await auditOf(kind, 'hand_over');
      expect(rest).toEqual([]);
      expect(entry).toMatchObject({ entityId: shared.id });
      expect(entry?.summary).toContain('"Team numbers"');
      expect(entry?.summary).toContain('Olive Owner');
      expect(entry?.summary).toContain(next.email);
      expect(entry?.summary).not.toContain(owner.email);
    });

    it('names an ownerless item\'s previous owner as nobody', async () => {
      const owner = await signInAs('editor');
      const shared = await sharedBy(kind, owner);
      await execRaw(`UPDATE ${kind.table} SET owner_id = NULL WHERE id = '${shared.id}'`);
      const next = await signInAs('admin');
      await kind.handOver(shared.id, next.id);
      const [entry] = await auditOf(kind, 'hand_over');
      expect(entry?.summary).toMatch(/no owner/i);
      expect(entry?.summary).toContain(next.email);
    });
  });

  describe(`taking over a ${kind.label}`, () => {
    it('makes the person the owner, keeps it Shared with its content, and moves the revision on by one', async () => {
      const owner = await signInAs('editor', { scoped: true });
      const shared = await sharedBy(kind, owner);
      const before = await kind.stored(shared.id);
      const admin = await signInAs('admin');
      const res = await kind.takeOver(shared.id);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: shared.id, visibility: 'shared', revision: shared.revision + 1, owner: { id: admin.id } });
      expect(await kind.stored(shared.id)).toEqual({ ...before, ownerId: admin.id, revision: shared.revision + 1 });
    });

    it('works on an item with no owner, for an Editor on Everything too', async () => {
      const owner = await signInAs('editor');
      const shared = await sharedBy(kind, owner);
      await execRaw(`UPDATE ${kind.table} SET owner_id = NULL WHERE id = '${shared.id}'`);
      const editor = await signInAs('editor');
      expect((await kind.takeOver(shared.id)).status).toBe(200);
      expect(await kind.stored(shared.id)).toMatchObject({ ownerId: editor.id });
    });

    it('is refused for a scoped Editor, a Viewer and an Editor with no Scope, who do not own it', async () => {
      const owner = await signInAs('editor');
      const shared = await sharedBy(kind, owner);
      for (const actor of [() => signInAs('editor', { scoped: true }), () => signInAs('viewer'), () => signInAs('editor', { noScope: true })]) {
        await actor();
        expect((await kind.takeOver(shared.id)).status).toBe(403);
      }
      expect(await kind.stored(shared.id)).toMatchObject({ ownerId: owner.id, revision: shared.revision });
    });

    it('is refused for a scoped Editor even on an item they own, since taking over is for items that are not theirs', async () => {
      const owner = await signInAs('editor', { scoped: true });
      const shared = await sharedBy(kind, owner);
      actAs(owner);
      expect((await kind.takeOver(shared.id)).status).toBe(403);
    });

    it('answers 409 with a reload message when the person already owns it', async () => {
      const admin = await signInAs('admin');
      const shared = await sharedBy(kind, admin);
      const res = await kind.takeOver(shared.id);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/reload/i);
      expect(await kind.stored(shared.id)).toMatchObject({ revision: shared.revision });
    });

    it('checks Shared names install-wide and answers 409 with the name-taken message on a clash', async () => {
      const owner = await signInAs('editor');
      await sharedBy(kind, owner, 'Overview');
      const second = await sharedBy(kind, owner, 'Other');
      await execRaw(`UPDATE ${kind.table} SET name = 'OVERVIEW' WHERE id = '${second.id}'`);
      await signInAs('admin');
      const res = await kind.takeOver(second.id);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe(`A ${kind.noun} named "OVERVIEW" already exists.`);
      expect(await kind.stored(second.id)).toMatchObject({ ownerId: owner.id });
    });

    it('logs the take-over with the item\'s name', async () => {
      const owner = await signInAs('editor', { scoped: true });
      const shared = await sharedBy(kind, owner);
      await signInAs('admin');
      await kind.takeOver(shared.id);
      const [entry, ...rest] = await auditOf(kind, 'take_over');
      expect(rest).toEqual([]);
      expect(entry).toMatchObject({ entityId: shared.id });
      expect(entry?.summary).toContain('"Team numbers"');
    });
  });
}

describe('the Install default', () => {
  it('stays the Install default through a hand-over and a take-over', async () => {
    const owner = await signInAs('admin');
    const shared = await sharedBy(dashboards, owner, 'Home');
    await setDefaultDashboard(shared.id);
    const next = await signInAs('editor');
    actAs(owner);
    expect((await dashboards.handOver(shared.id, next.id)).status).toBe(200);
    expect((await getDashboard(shared.id))?.isDefault).toBe(true);
    await signInAs('admin');
    expect((await dashboards.takeOver(shared.id)).status).toBe(200);
    expect((await getDashboard(shared.id))?.isDefault).toBe(true);
  });
});

describe('a hand-over decided against an owner who has since changed', () => {
  it('writes nothing for a dashboard or a saved view that changed hands in between', async () => {
    const owner = await signInAs('editor');
    const other = await signInAs('editor');
    const next = await signInAs('editor');
    for (const [kind, transfer] of [[dashboards, transferDashboard], [views, transferSavedView]] as const) {
      const shared = await sharedBy(kind, owner, `Between ${kind.label}`);
      await execRaw(`UPDATE ${kind.table} SET owner_id = '${other.id}' WHERE id = '${shared.id}'`);
      expect(await transfer(shared.id, owner.id, next.id)).toMatchObject({ ok: false, reason: 'wrong-state' });
      expect(await kind.stored(shared.id)).toMatchObject({ ownerId: other.id, revision: shared.revision });
    }
  });
});
