/**
 * Issue #161: two dashboards could end up with the same name, or two could both become the
 * default, when requests landed at the same moment. The name check (and for a first create the
 * "is the table empty" read) used to run in steps separate from the write, so two concurrent
 * requests could both pass the check before either wrote its row.
 *
 * Nothing here parks a request on a gate: the repository's steps are plain awaits on a synchronous
 * database, so two requests started together advance in lockstep and both finish their checks
 * before either reaches its write. That is exactly the interleaving the old code lost to, and it
 * is deterministic. Everything is the real route, repository and database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDashboards, execRaw, resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { listDashboards } from '@/lib/db/dashboards';
import { STARTER_DASHBOARD } from '@/lib/dashboard-templates';
import type { Dashboard } from '@/lib/types';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const { POST } = await import('@/app/api/dashboards/route');
const { PUT } = await import('@/app/api/dashboards/[id]/route');
const { POST: DUPLICATE } = await import('@/app/api/dashboards/[id]/duplicate/route');

function json(method: string, payload: unknown): Request {
  return new Request('http://localhost/api/dashboards', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function post(payload: unknown): Promise<Response> {
  return POST(json('POST', payload));
}

function put(id: string, payload: unknown): Promise<Response> {
  return PUT(json('PUT', payload), { params: Promise.resolve({ id }) });
}

function duplicate(id: string): Promise<Response> {
  return DUPLICATE(json('POST', {}), { params: Promise.resolve({ id }) });
}

async function created(name: string): Promise<Dashboard> {
  const res = await post({ name });
  expect(res.status).toBe(201);
  return await res.json() as Dashboard;
}

const TAKEN_MESSAGE = (name: string) => `A dashboard named "${name}" already exists.`;

function unique(label: string): string {
  return `${label} ${Math.random().toString(36).slice(2)}`;
}

function sameName(list: Dashboard[], name: string): Dashboard[] {
  return list.filter(d => d.name.trim().toLowerCase() === name.trim().toLowerCase());
}

describe('dashboard name uniqueness and first-default under concurrent writes', () => {
  beforeEach(async () => {
    await resetDb();
    await clearDashboards();
    mockAuth.mockReset();
    const result = await createUser({ email: 'editor@example.com', role: 'editor' });
    if ('error' in result) throw new Error(result.error);
    await setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
    mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
  });

  it('lets exactly one of two concurrent creates with the same name (different case) through', async () => {
    const name = unique('Race Dashboard');
    await created(unique('Existing')); // a non-empty table, so the first-default path is not involved

    const [resA, resB] = await Promise.all([post({ name }), post({ name: name.toUpperCase() })]);

    expect([resA.status, resB.status].sort()).toEqual([201, 409]);
    const aFailed = resA.status === 409;
    const failedName = aFailed ? name : name.toUpperCase();
    expect((await (aFailed ? resA : resB).json()).error).toBe(TAKEN_MESSAGE(failedName));
    expect(sameName(await listDashboards(), name)).toHaveLength(1);
  });

  it('lets exactly one of two concurrent renames to the same name through', async () => {
    const a = await created(unique('Rename A'));
    const b = await created(unique('Rename B'));
    const shared = unique('Shared Name');

    const [resA, resB] = await Promise.all([put(a.id, { name: shared }), put(b.id, { name: shared.toUpperCase() })]);

    expect([resA.status, resB.status].sort()).toEqual([200, 409]);
    const aFailed = resA.status === 409;
    const failedName = aFailed ? shared : shared.toUpperCase();
    expect((await (aFailed ? resA : resB).json()).error).toBe(TAKEN_MESSAGE(failedName));
    expect(sameName(await listDashboards(), shared)).toHaveLength(1);
  });

  it('gives concurrent duplicates of one dashboard distinct names', async () => {
    const source = await created(unique('Source'));

    const responses = await Promise.all([duplicate(source.id), duplicate(source.id), duplicate(source.id)]);

    expect(responses.map(r => r.status)).toEqual([201, 201, 201]);
    const names = (await Promise.all(responses.map(r => r.json() as Promise<Dashboard>))).map(d => d.name).sort();
    expect(names).toEqual([`${source.name} (copy 2)`, `${source.name} (copy 3)`, `${source.name} (copy)`].sort());
  });

  it('gives concurrent starter restores distinct names', async () => {
    const responses = await Promise.all([post({ template: 'starter' }), post({ template: 'starter' })]);

    expect(responses.map(r => r.status)).toEqual([201, 201]);
    const names = (await Promise.all(responses.map(r => r.json() as Promise<Dashboard>))).map(d => d.name).sort();
    expect(names).toEqual([STARTER_DASHBOARD.name, `${STARTER_DASHBOARD.name} (2)`].sort());
  });

  it('makes exactly one dashboard the default when two creates land on an empty table', async () => {
    const responses = await Promise.all([post({ name: unique('First A') }), post({ name: unique('First B') })]);

    expect(responses.map(r => r.status)).toEqual([201, 201]);
    const all = await listDashboards();
    expect(all).toHaveLength(2);
    expect(all.filter(d => d.isDefault)).toHaveLength(1);
  });

  it('lets an update that keeps an existing duplicate pair\'s name succeed', async () => {
    const shared = unique('Pre-existing Duplicate');
    const config = JSON.stringify({ autoRefresh: 0, widgets: [] });
    await execRaw(`INSERT INTO dashboards (id, name, config, is_default, created_at) VALUES ('dup-older', '${shared}', '${config}', TRUE, '2024-01-01T00:00:00.000Z')`);
    await execRaw(`INSERT INTO dashboards (id, name, config, is_default, created_at) VALUES ('dup-newer', '${shared.toUpperCase()}', '${config}', FALSE, '2024-02-01T00:00:00.000Z')`);

    const res = await put('dup-older', { name: shared, description: 'edited without renaming' });

    expect(res.status).toBe(200);
    const updated = (await listDashboards()).find(d => d.id === 'dup-older');
    expect(updated?.description).toBe('edited without renaming');
    expect(updated?.name).toBe(shared);
  });

  it('still refuses a rename onto another dashboard\'s name, and still answers 404 for a missing one', async () => {
    const a = await created(unique('Keep A'));
    const b = await created(unique('Keep B'));

    const clash = await put(b.id, { name: a.name.toUpperCase() });
    expect(clash.status).toBe(409);
    expect((await clash.json()).error).toBe(TAKEN_MESSAGE(a.name.toUpperCase()));

    expect((await put('no-such-dashboard', { name: unique('Anything') })).status).toBe(404);
    expect((await duplicate('no-such-dashboard')).status).toBe(404);
  });
});
