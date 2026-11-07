/**
 * Issue #419: every change to a dashboard's widgets, name, description or refresh interval goes
 * through one PUT that checks the revision, validates what it writes and audits it. Everything is
 * the real route, repository and database; only the session is mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDashboards, execRaw, resetDb } from '../helpers/db';
import { createUser, deleteUser } from '@/lib/db/users';
import { createDashboard, getDashboard } from '@/lib/db/dashboards';
import { listAuditEntries } from '@/lib/db/audit';
import type { Dashboard, DashboardConfig } from '@/lib/types';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const { PUT, GET } = await import('@/app/api/dashboards/[id]/route');

const signIn = (userId: string) => mockAuth.mockResolvedValue({ user: { uid: userId } });

function put(id: string, payload: unknown): Promise<Response> {
  return PUT(new Request(`http://localhost/api/dashboards/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  }), { params: Promise.resolve({ id }) });
}

const widget = (over: Record<string, unknown> = {}) =>
  ({ id: 'w1', type: 'stat-card', title: 'Open', x: 0, y: 0, w: 3, h: 3, config: { metric: 'total-findings' }, ...over });
const configOf = (...widgets: unknown[]): DashboardConfig => ({ autoRefresh: 0, widgets: widgets as DashboardConfig['widgets'] });

const unique = (label: string) => `${label} ${Math.random().toString(36).slice(2)}`;

async function person(email: string, role: 'viewer' | 'editor' | 'admin', name?: string): Promise<string> {
  const made = await createUser({ email, role, name });
  if ('error' in made) throw new Error(made.error);
  return made.user.id;
}

async function shared(name: string, config: DashboardConfig = configOf(widget()), actorId: string | null = null): Promise<Dashboard> {
  const made = await createDashboard({ name, config }, actorId);
  if (!made.ok) throw new Error(made.reason);
  return made.dashboard;
}

async function personal(name: string, ownerId: string): Promise<Dashboard> {
  const id = `personal-${Math.random().toString(36).slice(2)}`;
  await execRaw(`INSERT INTO dashboards (id, name, config, is_default, created_at, owner_id, visibility) VALUES ('${id}', '${name}', '${JSON.stringify(configOf())}', FALSE, '2026-01-01T00:00:00.000Z', '${ownerId}', 'personal')`);
  return (await getDashboard(id))!;
}

let editor: string;
let viewer: string;

beforeEach(async () => {
  await resetDb();
  await clearDashboards();
  mockAuth.mockReset();
  editor = await person('editor@example.com', 'editor', 'Edie Editor');
  viewer = await person('viewer@example.com', 'viewer');
  signIn(editor);
});

describe('the revision', () => {
  it('is bumped by a save, which returns the new one and who wrote it', async () => {
    const d = await shared(unique('Revised'));
    expect(d.revision).toBe(1);

    const res = await put(d.id, { description: 'first', revision: 1 });

    expect(res.status).toBe(200);
    const saved = await res.json() as Dashboard;
    expect(saved.revision).toBe(2);
    expect(saved.updatedBy).toBe(editor);
    expect(saved.updatedAt).toEqual(expect.any(String));
    expect((await put(d.id, { description: 'second', revision: 2 })).status).toBe(200);
    expect((await getDashboard(d.id))!.revision).toBe(3);
  });

  it('answers 400 when a save does not carry one', async () => {
    const d = await shared(unique('No revision'));

    for (const revision of [undefined, '1', 1.5, null]) {
      const res = await put(d.id, { description: 'x', revision });
      expect(res.status, String(revision)).toBe(400);
      expect((await res.json()).reason).toBe('revision-required');
    }
    expect((await getDashboard(d.id))!.revision).toBe(1);
  });

  it('answers a stale one with 409, the reason, the editor\'s display name and when, and writes nothing', async () => {
    const d = await shared(unique('Contested'));
    const other = await person('other@example.com', 'editor', 'Olga Other');
    signIn(other);
    expect((await put(d.id, { description: 'theirs', revision: 1 })).status).toBe(200);
    const writtenAt = (await getDashboard(d.id))!.updatedAt;
    signIn(editor);

    const res = await put(d.id, { description: 'mine', revision: 1 });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'This dashboard was changed by someone else after you opened it.',
      reason: 'revision-conflict', editor: 'Olga Other', at: writtenAt,
    });
    const stored = (await getDashboard(d.id))!;
    expect(stored.description).toBe('theirs');
    expect(stored.revision).toBe(2);
  });

  it('names the editor by email when they have no name yet', async () => {
    const d = await shared(unique('Nameless'));
    const other = await person('nameless@example.com', 'editor');
    signIn(other);
    await put(d.id, { description: 'theirs', revision: 1 });
    signIn(editor);

    expect((await (await put(d.id, { description: 'mine', revision: 1 })).json()).editor).toBe('nameless@example.com');
  });

  it('gives no editor for a user who is no longer in RuleBeat', async () => {
    const d = await shared(unique('Departed'));
    const gone = await person('gone@example.com', 'editor', 'Gone Person');
    signIn(gone);
    await put(d.id, { description: 'theirs', revision: 1 });
    await deleteUser(gone);
    signIn(editor);

    const body = await (await put(d.id, { description: 'mine', revision: 1 })).json();

    expect(body.reason).toBe('revision-conflict');
    expect(body.editor).toBeNull();
    expect(body.at).toEqual(expect.any(String));
  });

  it('gives no editor, and the creation time, for a row no write has named', async () => {
    const d = await shared(unique('Unnamed'));
    await execRaw(`UPDATE dashboards SET revision = 5, updated_by = NULL, updated_at = NULL WHERE id = '${d.id}'`);

    const body = await (await put(d.id, { description: 'mine', revision: 1 })).json();

    expect(body).toMatchObject({ reason: 'revision-conflict', editor: null, at: d.createdAt });
  });

  it('is checked before a taken name, so a stale save is told that first', async () => {
    const a = await shared(unique('Order A'));
    const b = await shared(unique('Order B'));
    await put(b.id, { description: 'moved on', revision: 1 });

    const res = await put(b.id, { name: a.name, revision: 1 });

    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('revision-conflict');
  });

  it('is checked before the config, so a stale save is told that first', async () => {
    const d = await shared(unique('Order C'));
    await put(d.id, { description: 'moved on', revision: 1 });

    const res = await put(d.id, { config: configOf(widget({ w: 5 })), revision: 1 });

    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('revision-conflict');
  });

  it('is not given to someone who cannot edit the dashboard', async () => {
    const d = await shared(unique('Hidden'), configOf(), editor);
    signIn(viewer);

    const asViewer = await put(d.id, { description: 'x', revision: 99 });
    expect(asViewer.status).toBe(403);
    expect(await asViewer.json()).toEqual({ error: 'Forbidden' });

    const mine = await personal(unique('Not yours'), editor);
    const asStranger = await put(mine.id, { description: 'x', revision: 99 });
    expect(asStranger.status).toBe(404);
    expect(await asStranger.json()).toEqual({ error: 'Not found' });
  });
});

describe('the name', () => {
  it('answers a taken one with 409 and the reason, case and spacing aside', async () => {
    const a = await shared(unique('Taken'));
    const b = await shared(unique('Wanting'));

    const res = await put(b.id, { name: `  ${a.name.toUpperCase()} `, revision: 1 });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: `A dashboard named "${a.name.toUpperCase()}" already exists.`, reason: 'name-taken' });
    expect((await getDashboard(b.id))!.revision).toBe(1);
  });

  it.each(['', '   '])('answers an empty one (%j) with 400', async (name) => {
    const d = await shared(unique('Blank'));

    const res = await put(d.id, { name, revision: 1 });

    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe('empty-name');
    expect((await getDashboard(d.id))!.revision).toBe(1);
  });

  it('answers 400 for a name or description that is not text', async () => {
    const d = await shared(unique('Typed'));
    expect((await put(d.id, { name: 7, revision: 1 })).status).toBe(400);
    expect((await put(d.id, { description: ['x'], revision: 1 })).status).toBe(400);
  });

  it('keeps the trimmed name', async () => {
    const d = await shared(unique('Trim'));
    const res = await put(d.id, { name: '  Trimmed name  ', revision: 1 });
    expect((await res.json() as Dashboard).name).toBe('Trimmed name');
  });
});

describe('the widgets', () => {
  it.each([
    ['a known type whose w is not an allowed span', { w: 5 }],
    ['an x that is negative', { x: -1 }],
    ['a y that is fractional', { y: 1.5 }],
    ['an h that is text', { h: '3' }],
  ])('answers 400 for %s', async (_label, over) => {
    const d = await shared(unique('Invalid'));

    const res = await put(d.id, { config: configOf(widget(over)), revision: 1 });

    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe('invalid-config');
    const stored = (await getDashboard(d.id))!;
    expect(stored.revision).toBe(1);
    expect(stored.config.widgets[0]!.w).toBe(3);
  });

  it('answers 400 for duplicate widget ids', async () => {
    const d = await shared(unique('Duplicated'));
    const res = await put(d.id, { config: configOf(widget(), widget({ y: 3 })), revision: 1 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('share the id');
  });

  it('accepts zero widgets', async () => {
    const d = await shared(unique('Emptied'));
    const res = await put(d.id, { config: configOf(), revision: 1 });
    expect(res.status).toBe(200);
    expect((await getDashboard(d.id))!.config.widgets).toEqual([]);
  });

  it('checks the config of a save that also renames, and refuses before it renames', async () => {
    const d = await shared(unique('Both'));
    const res = await put(d.id, { name: unique('Renamed'), config: configOf(widget({ w: 5 })), revision: 1 });
    expect(res.status).toBe(400);
    expect((await getDashboard(d.id))!.name).toBe(d.name);
  });

  describe('of a type this build does not know', () => {
    const future = (over: Record<string, unknown> = {}) => widget({ id: 'f1', type: 'from-the-future', w: 6, config: { a: 1 }, ...over });
    async function withFuture(): Promise<Dashboard> {
      const d = await shared(unique('Future'));
      // As an older or newer build left it: stored directly, never through this PUT.
      await execRaw(`UPDATE dashboards SET config = '${JSON.stringify(configOf(widget(), future({ w: 5 })))}' WHERE id = '${d.id}'`);
      return d;
    }

    it('is accepted when the row holds it with the same type and config and w is 6 or 12', async () => {
      const d = await withFuture();
      for (const [w, revision] of [[6, 1], [12, 2]] as const) {
        const res = await put(d.id, { config: configOf(widget({ x: 5 }), future({ w })), revision });
        expect(res.status, `w=${w}`).toBe(200);
      }
    });

    it('answers 400 for a new one', async () => {
      const d = await shared(unique('Newcomer'));
      const res = await put(d.id, { config: configOf(widget(), future()), revision: 1 });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('cannot be added or changed');
    });

    it('answers 400 when its config changed or its w is not 6 or 12', async () => {
      const d = await withFuture();
      expect((await put(d.id, { config: configOf(future({ config: { a: 2 } })), revision: 1 })).status).toBe(400);
      expect((await put(d.id, { config: configOf(future({ w: 4 })), revision: 1 })).status).toBe(400);
      expect((await getDashboard(d.id))!.revision).toBe(1);
    });

    it('is compared with the row as stored, not as migrated for display', async () => {
      const d = await shared(unique('Legacy'));
      await execRaw(`UPDATE dashboards SET config = '${JSON.stringify(configOf(widget({ id: 'old', type: 'findings-table', w: 5, config: { limit: 5 } })))}' WHERE id = '${d.id}'`);
      // The read renames the type, so the editor sends back the known one, held to its spans.
      const read = (await getDashboard(d.id))!;
      expect(read.config.widgets[0]!.type).toBe('recent-findings');
      expect((await put(d.id, { config: configOf({ ...read.config.widgets[0], w: 7 }), revision: 1 })).status).toBe(200);
    });
  });

  it('leaves a stored row alone on read, whatever it holds', async () => {
    const d = await shared(unique('Untouched'));
    const stored = configOf(widget({ w: 5, x: -2 }), widget({ y: 1.5 }));
    await execRaw(`UPDATE dashboards SET config = '${JSON.stringify(stored)}' WHERE id = '${d.id}'`);

    const read = await GET(new Request('http://localhost/api/dashboards/x'), { params: Promise.resolve({ id: d.id }) });

    expect(read.status).toBe(200);
    expect((await read.json() as Dashboard).config.widgets).toEqual(stored.widgets);
    expect((await getDashboard(d.id))!.revision).toBe(1);
  });
});

describe('the audit entry', () => {
  const saves = async () => (await listAuditEntries({ limit: 200 })).filter(e => e.action === 'dashboard.update');

  it('names every field a save changed, once, and never what they held', async () => {
    const d = await shared(unique('Audited'));
    const newName = unique('Secret name');

    const res = await put(d.id, {
      name: newName, description: 'secret description', revision: 1,
      config: { autoRefresh: 60, widgets: [widget({ title: 'secret title', w: 6 })] },
    });

    expect(res.status).toBe(200);
    const entries = await saves();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actorId: editor, entityType: 'dashboard', entityId: d.id, details: { changed: ['widgets', 'name', 'description', 'autoRefresh'] } });
    const written = JSON.stringify(entries[0]);
    for (const value of [newName, d.name, 'secret description', 'secret title']) expect(written).not.toContain(value);
  });

  it.each([
    ['widgets', { config: configOf(widget({ x: 3 })) }],
    ['name', { name: 'Only the name' }],
    ['description', { description: 'Only the description' }],
    ['autoRefresh', { config: { ...configOf(widget()), autoRefresh: 300 } }],
  ])('names only %s when only that changed', async (field, change) => {
    const d = await shared(unique('Single'));

    expect((await put(d.id, { ...change, revision: 1 })).status).toBe(200);

    expect((await saves()).map(e => e.details)).toEqual([{ changed: [field] }]);
  });

  it('writes one per save', async () => {
    const d = await shared(unique('Twice'));
    await put(d.id, { description: 'one', revision: 1 });
    await put(d.id, { description: 'two', revision: 2 });
    expect(await saves()).toHaveLength(2);
  });

  it('writes none for a refused save', async () => {
    const d = await shared(unique('Refused'));
    await put(d.id, { description: 'x', revision: 9 });
    await put(d.id, { name: '', revision: 1 });
    await put(d.id, { config: configOf(widget({ w: 5 })), revision: 1 });
    expect(await saves()).toEqual([]);
  });

  it('writes none when the save changes none of the four, such as the filter bar\'s own', async () => {
    const d = await shared(unique('Filtered'));

    const res = await put(d.id, { config: { ...configOf(widget()), filters: { severities: ['high'] } }, revision: 1 });

    expect(res.status).toBe(200);
    expect((await getDashboard(d.id))!.config.filters).toEqual({ severities: ['high'] });
    expect(await saves()).toEqual([]);
  });

  it('does not name a Personal dashboard', async () => {
    const mine = await personal(unique('Private plans'), viewer);
    signIn(viewer);

    await put(mine.id, { description: 'x', revision: 1 });

    const [entry] = await saves();
    expect(entry!.summary).toBe('Changed a Personal dashboard: description');
    expect(JSON.stringify(entry)).not.toContain(mine.name);
  });
});

describe('who may save', () => {
  it('lets the owner of a Personal dashboard save it through the Personal action, whatever their Role', async () => {
    const mine = await personal(unique('Mine'), viewer);
    signIn(viewer);

    const res = await put(mine.id, { name: unique('Still mine'), revision: 1 });

    expect(res.status).toBe(200);
    expect((await res.json() as Dashboard).revision).toBe(2);
  });

  it('answers someone else\'s Personal dashboard as if it did not exist, an Admin included', async () => {
    const theirs = await personal(unique('Theirs'), viewer);
    const admin = await person('admin@example.com', 'admin');

    for (const uid of [editor, admin]) {
      signIn(uid);
      expect((await put(theirs.id, { description: 'x', revision: 1 })).status).toBe(404);
    }
    expect((await getDashboard(theirs.id))!.revision).toBe(1);
  });

  it('keeps a Shared dashboard install-wide: an Editor saves it, a Viewer is refused', async () => {
    const d = await shared(unique('Wide'));
    signIn(viewer);
    expect((await put(d.id, { description: 'x', revision: 1 })).status).toBe(403);
    signIn(editor);
    expect((await put(d.id, { description: 'x', revision: 1 })).status).toBe(200);
  });

  it('keeps a row with no owner Shared, so an Editor saves it and a Viewer is refused', async () => {
    const d = await shared(unique('Ownerless'));
    expect(d).toMatchObject({ ownerId: null, visibility: 'shared' });
    signIn(viewer);
    expect((await put(d.id, { description: 'x', revision: 1 })).status).toBe(403);
    signIn(editor);
    expect((await put(d.id, { description: 'x', revision: 1 })).status).toBe(200);
  });

  it('keeps a row marked Personal that has no owner install-wide', async () => {
    const d = await shared(unique('Orphaned'));
    await execRaw(`UPDATE dashboards SET visibility = 'personal', owner_id = NULL WHERE id = '${d.id}'`);
    signIn(viewer);
    expect((await put(d.id, { description: 'x', revision: 1 })).status).toBe(403);
    signIn(editor);
    expect((await put(d.id, { description: 'x', revision: 1 })).status).toBe(200);
  });

  it('answers a missing dashboard with 404 before anything else', async () => {
    expect((await put('no-such-dashboard', { description: 'x', revision: 1 })).status).toBe(404);
  });
});

describe('the Personal name space', () => {
  it('lets a Personal dashboard take another person\'s Personal name, and refuses a Shared name or one of its owner\'s own', async () => {
    const other = await person('other@example.com', 'viewer');
    const theirs = await personal(unique('Their plans'), other);
    const sharedOne = await shared(unique('Everyone sees'));
    const ownA = await personal(unique('Own A'), viewer);
    const ownB = await personal(unique('Own B'), viewer);
    const ownC = await personal(unique('Own C'), viewer);
    signIn(viewer);

    expect((await put(ownC.id, { name: theirs.name, revision: 1 })).status).toBe(200);

    const toShared = await put(ownB.id, { name: sharedOne.name, revision: 1 });
    expect(toShared.status).toBe(409);
    expect((await toShared.json()).reason).toBe('name-taken');
    const toOwn = await put(ownB.id, { name: ownA.name.toLowerCase(), revision: 1 });
    expect(toOwn.status).toBe(409);
    expect((await toOwn.json()).reason).toBe('name-taken');
  });

  it('lets a Shared dashboard take a name only someone\'s Personal dashboard holds', async () => {
    const theirs = await personal(unique('Quiet name'), viewer);
    const d = await shared(unique('Loud name'));

    expect((await put(d.id, { name: theirs.name, revision: 1 })).status).toBe(200);
  });
});

describe('making a dashboard the default', () => {
  it('moves the flag and answers the dashboard as it now stands', async () => {
    const first = await shared(unique('First'));
    const second = await shared(unique('Second'));
    expect(first.isDefault).toBe(true);

    const res = await put(second.id, { isDefault: true });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: second.id, isDefault: true, revision: 2 });
    expect((await getDashboard(first.id))).toMatchObject({ isDefault: false, revision: 2 });
  });

  it('is not offered to a Personal dashboard', async () => {
    const mine = await personal(unique('Personal default'), viewer);
    signIn(viewer);
    expect((await put(mine.id, { isDefault: true })).status).toBe(400);
  });

  it('is refused to a Viewer on a Shared dashboard', async () => {
    const d = await shared(unique('Not for viewers'));
    signIn(viewer);
    expect((await put(d.id, { isDefault: true })).status).toBe(403);
  });
});
