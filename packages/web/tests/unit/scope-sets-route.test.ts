/**
 * POST /api/scope-sets (ADR 0016): turns a long Scope list into a hash the address can carry. The server
 * validates every path, computes the hash itself, and only takes paths the caller holds (Everything may
 * send any). Real `requireRole` and repositories; only the session is mocked.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createPeople, matrixHierarchy, SCOPE_MANAGEMENT_GROUP, SCOPE_RESOURCE_GROUP, SCOPE_SUBSCRIPTION, SUB_TWO } from '../helpers/access-matrix';
import { db } from '@/lib/db/client';
import { run } from '@/lib/db/exec';
import { scopeSets } from '@/lib/db/tables';
import { createUser } from '@/lib/db/users';
import { countAuditEntries } from '@/lib/db/audit';
import { expandScopeSet } from '@/lib/db/scope-sets';
import { SCOPE_SET_MAX_BODY_BYTES, SCOPE_SET_MAX_PATHS } from '@/lib/scope-sets';
import { refreshFrom } from '../helpers/fake-hierarchy';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const { POST } = await import('@/app/api/scope-sets/route');

const SUB_TWO_PATH = `/subscriptions/${SUB_TWO}`;
const HASH_SUB_ONE = 'f63363efa2a6b8edecf9bbb166f0c2d15d8d5a53083838af1ff66e7f06b05c64';

const post = (body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  POST(new Request('http://localhost/api/scope-sets', {
    method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body),
  }));

let ids: Record<string, string>;
const signInAs = (person: string) => mockAuth.mockResolvedValue({ user: { uid: ids[person] } });

beforeAll(async () => {
  await resetDb();
  ids = await createPeople();
  await refreshFrom(matrixHierarchy());
});
beforeEach(async () => {
  await run(db.delete(scopeSets));
  signInAs('Viewer on one subscription');
});

describe('POST /api/scope-sets', () => {
  it('answers 401 for nobody signed in', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await post({ paths: [SCOPE_SUBSCRIPTION] })).status).toBe(401);
  });

  it('stores a held list and answers with the server\'s own hash', async () => {
    const res = await post({ paths: [SCOPE_SUBSCRIPTION] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hash: HASH_SUB_ONE, count: 1 });
    expect(await expandScopeSet(HASH_SUB_ONE)).toEqual({ status: 'resolved', paths: [SCOPE_SUBSCRIPTION] });
  });

  it('answers the same hash for the same set sent again, in other casing', async () => {
    await post({ paths: [SCOPE_SUBSCRIPTION] });
    const again = await post({ paths: [SCOPE_SUBSCRIPTION.toUpperCase()] });
    expect(await again.json()).toEqual({ hash: HASH_SUB_ONE, count: 1 });
    expect(await expandScopeSet(HASH_SUB_ONE)).toEqual({ status: 'resolved', paths: [SCOPE_SUBSCRIPTION] });
  });

  it('ignores a hash the client sends and answers with its own', async () => {
    const res = await post({ paths: [SCOPE_SUBSCRIPTION], hash: 'a'.repeat(64) });
    expect((await res.json()).hash).toBe(HASH_SUB_ONE);
    expect(await expandScopeSet('a'.repeat(64))).toEqual({ status: 'unresolved' });
  });

  it('takes any path from Everything', async () => {
    signInAs('Editor on Everything');
    const res = await post({ paths: [SCOPE_MANAGEMENT_GROUP, SUB_TWO_PATH, SCOPE_RESOURCE_GROUP, '@directory'] });
    expect(res.status).toBe(200);
    expect((await res.json()).count).toBe(4);
  });

  it('takes what sits under a held management group', async () => {
    signInAs('Viewer on the management group');
    expect((await post({ paths: [SCOPE_MANAGEMENT_GROUP, SUB_TWO_PATH, SCOPE_RESOURCE_GROUP] })).status).toBe(200);
  });

  it('takes a subscription the caller holds only in part, since it applies as the part they hold', async () => {
    signInAs('Viewer on one resource group');
    const res = await post({ paths: [SCOPE_SUBSCRIPTION, SCOPE_RESOURCE_GROUP] });
    expect(res.status).toBe(200);
    expect((await res.json()).count).toBe(2);
  });

  it('takes a management group the caller holds in part, and refuses one they hold none of', async () => {
    signInAs('Viewer on one subscription');
    expect((await post({ paths: [SCOPE_MANAGEMENT_GROUP] })).status).toBe(200);
    signInAs('No Scope');
    expect((await post({ paths: [SCOPE_MANAGEMENT_GROUP] })).status).toBe(400);
  });

  it('refuses a path outside the Scopes the caller holds, with a stable message that names nothing', async () => {
    const res = await post({ paths: [SCOPE_SUBSCRIPTION, SUB_TWO_PATH] });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: 'A path in the list is outside the Scopes you hold.' });
    expect(JSON.stringify(body)).not.toContain(SUB_TWO);
  });

  it('refuses every path for a person who holds no Scope', async () => {
    signInAs('No Scope');
    expect((await post({ paths: [SCOPE_SUBSCRIPTION] })).status).toBe(400);
  });

  it('stores nothing for a refused list', async () => {
    await post({ paths: [SCOPE_SUBSCRIPTION, SUB_TWO_PATH] });
    expect(await expandScopeSet(HASH_SUB_ONE)).toEqual({ status: 'unresolved' });
  });

  it.each([
    ['Everything', ['/']],
    ['a resource', [`${SCOPE_RESOURCE_GROUP}/providers/Microsoft.Compute/virtualMachines/vm`]],
    ['text', ['not a scope']],
    ['a number', [1]],
  ])('refuses %s with a stable message, even from Everything', async (_name, paths) => {
    signInAs('Admin');
    const res = await post({ paths });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Send paths as a list of management group, subscription, resource group or Directory paths.' });
  });

  it.each([
    ['no paths', {}],
    ['an empty list', { paths: [] }],
    ['paths that is not a list', { paths: SCOPE_SUBSCRIPTION }],
    ['a body that is not an object', [SCOPE_SUBSCRIPTION]],
  ])('refuses %s', async (_name, body) => {
    expect((await post(body)).status).toBe(400);
  });

  it('refuses a body that is not JSON, and a Content-Type that does not say so', async () => {
    expect((await post('{"paths":')).status).toBe(400);
    expect((await post({ paths: [SCOPE_SUBSCRIPTION] }, { 'content-type': 'text/plain' })).status).toBe(415);
  });

  it('takes a set at the cap and refuses one over it', async () => {
    signInAs('Admin');
    const paths = (n: number) => Array.from({ length: n }, (_, i) => `/subscriptions/${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`);
    expect((await post({ paths: paths(SCOPE_SET_MAX_PATHS) })).status).toBe(200);
    const over = await post({ paths: paths(SCOPE_SET_MAX_PATHS + 1) });
    expect(over.status).toBe(400);
    expect(await over.json()).toEqual({ error: `A set holds at most ${SCOPE_SET_MAX_PATHS} paths.` });
  });

  it('refuses a body over the cap without parsing it, whether or not the length is declared', async () => {
    signInAs('Admin');
    const padded = JSON.stringify({ paths: [SCOPE_SUBSCRIPTION], padding: 'x'.repeat(SCOPE_SET_MAX_BODY_BYTES) });
    const undeclared = await post(padded);
    expect(undeclared.status).toBe(413);
    const declared = await post('{}', { 'content-type': 'application/json', 'content-length': String(SCOPE_SET_MAX_BODY_BYTES + 1) });
    expect(declared.status).toBe(413);
  });

  it('writes no audit entry', async () => {
    const before = await countAuditEntries();
    await post({ paths: [SCOPE_SUBSCRIPTION] });
    expect(await countAuditEntries()).toBe(before);
  });

  it('answers a person removed from the install with 401, as every route does', async () => {
    const gone = await createUser({ email: 'gone@example.com', role: 'viewer' });
    if ('error' in gone) throw new Error(gone.error);
    mockAuth.mockResolvedValue({ user: { uid: `${gone.user.id}-missing` } });
    expect((await post({ paths: [SCOPE_SUBSCRIPTION] })).status).toBe(401);
  });
});
