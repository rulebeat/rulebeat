/**
 * #278: POST /api/users/[id]/mirror/preview, PUT /api/users/[id]/mirror and POST /api/users/[id]/mirror/refresh,
 * the Mirrored access an Admin gives from the Access page, and what the existing access and Role routes do to a
 * mirrored person. The real `requireRole` and real repositories, with only the session (`@/auth`), the Azure
 * tenant id and the reader (the Azure call) replaced. Admin-only, preview writes nothing, no Azure error text in
 * any response, and one audit entry per write that names no object id, tenant id or Scope path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser, getUser, setManualAccess, setMirroredAccess, type AppUser } from '@/lib/db/users';
import { listAssignmentsFor, listAllAssignments } from '@/lib/db/role-assignments';
import { listAllAuditEntries } from '@/lib/db/audit';
import { db } from '@/lib/db/client';
import { users as usersTable } from '@/lib/db/tables';
import { eq } from 'drizzle-orm';
import { many } from '@/lib/db/exec';
import { AzureNotConfiguredError } from '@/lib/azure-credential';
import { NO_AZURE_CONNECTION_MESSAGE } from '@/lib/manual-access';
import { MIRROR_FAILED_MESSAGE } from '@/lib/access-mirror-model';
import type { Role } from '@/lib/rbac';
import {
  ACCOUNT, MG_EXAMPLE, MIRROR_TENANT, OTHER_ACCOUNT, SUB_A, SUB_B, fakeRoleAssignments, type FakeRoleAssignments,
} from '../helpers/fake-role-assignments';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const mockTenant = vi.fn();
vi.mock('@/lib/arm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/arm')>()),
  getArmTenantId: () => mockTenant(),
}));

// Everything but the Azure read is real: the mirror runs over whatever `azure` holds, and never waits for real.
let azure: FakeRoleAssignments;
vi.mock('@/lib/access-mirror', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/access-mirror')>();
  const deps = () => ({ read: azure.read, wait: async () => undefined });
  return {
    ...actual,
    mirrorAccount: (objectId: string) => actual.mirrorAccount(objectId, deps()),
    refreshMirroredUser: (user: AppUser) => actual.refreshMirroredUser(user, deps()),
  };
});

const preview = await import('@/app/api/users/[id]/mirror/preview/route');
const confirm = await import('@/app/api/users/[id]/mirror/route');
const refresh = await import('@/app/api/users/[id]/mirror/refresh/route');
const accessRoute = await import('@/app/api/users/[id]/access/route');
const userRoute = await import('@/app/api/users/[id]/route');

const LEAK = 'AuthorizationFailed: client 00000000-aaaa-bbbb-cccc-000000000000 over /subscriptions/secret-sub, correlation 11111111-2222';
const RG_ONE = `${SUB_A}/resourceGroups/rg-one`;

const jsonRequest = (method: string, body: unknown): Request => new Request('http://localhost/api/test', {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const params = (id: string) => ({ params: Promise.resolve({ id }) });

const previewOf = (id: string, objectId: unknown = ACCOUNT) => preview.POST(jsonRequest('POST', { objectId }), params(id));
const confirmOf = (id: string, body: unknown = { objectId: ACCOUNT, role: 'viewer' }) => confirm.PUT(jsonRequest('PUT', body), params(id));
const refreshOf = (id: string) => refresh.POST(new Request('http://localhost/api/test', { method: 'POST' }), params(id));

async function makeUser(email: string, role: Role): Promise<AppUser> {
  const result = await createUser({ email, role });
  if ('error' in result) throw new Error(result.error);
  return result.user;
}
const signInAs = (user: AppUser) => mockAuth.mockResolvedValue({ user: { uid: user.id } });
const auditFor = async (action: string) => (await listAllAuditEntries()).filter(e => e.action === action);

/**
 * The stored Linked account columns of one person, read straight from the table. `AppUser` shows a Linked account
 * only for a mirrored person, so a column left behind by a write that should have cleared it is invisible through
 * the repository: these are what say it really is gone.
 */
async function linkColumns(id: string) {
  const [row] = await many(db.select({
    tenant: usersTable.linkedTenantId, object: usersTable.linkedObjectId, success: usersTable.mirrorLastSuccessAt,
    attempt: usersTable.mirrorLastAttemptAt, error: usersTable.mirrorError,
  }).from(usersTable).where(eq(usersTable.id, id)));
  return row;
}
const NO_LINK = { tenant: null, object: null, success: null, attempt: null, error: null };

/** Everything a person's stored access is made of, to compare before and after. */
async function stored(id: string) {
  return { user: await getUser(id), rows: await listAssignmentsFor(id) };
}

let admin: AppUser;
let target: AppUser;

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
  mockTenant.mockReset();
  mockTenant.mockResolvedValue(MIRROR_TENANT);
  azure = fakeRoleAssignments({
    assignments: [
      { objectId: ACCOUNT, scope: SUB_A, role: 'Reader' },
      { objectId: ACCOUNT, scope: `${RG_ONE}/providers/Microsoft.Compute/virtualMachines/vm-one`, role: 'Owner', principalType: 'Group' },
      { objectId: ACCOUNT, scope: MG_EXAMPLE, role: 'Contributor', eligible: true },
    ],
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  admin = await makeUser('admin@example.com', 'admin');
  target = await makeUser('target@example.com', 'viewer');
  signInAs(admin);
});

describe('POST /api/users/[id]/mirror/preview', () => {
  it('answers with the Scopes the mirror would give, each with the Azure roles behind it', async () => {
    const res = await previewOf(target.id);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.scopes).toEqual([
      { scope: MG_EXAMPLE, kind: 'managementGroup', origins: [{ roleName: 'Contributor', throughGroup: false, eligible: true }] },
      { scope: SUB_A, kind: 'subscription', origins: [{ roleName: 'Reader', throughGroup: false, eligible: false }] },
      { scope: RG_ONE, kind: 'resourceGroup', origins: [{ roleName: 'Owner', throughGroup: true, eligible: false }] },
    ]);
    expect(body.alsoLinkedTo).toEqual([]);
  });

  it('answers a read that finds nothing with no Scopes', async () => {
    azure.assignments = [];
    const body = await (await previewOf(target.id)).json();
    expect(body.scopes).toEqual([]);
  });

  it('changes nothing and writes no audit entry', async () => {
    await setManualAccess(target.id, [{ tenantId: MIRROR_TENANT, scope: SUB_B, role: 'viewer' }]);
    const before = await stored(target.id);
    const allRowsBefore = await listAllAssignments();

    await previewOf(target.id);

    expect(await stored(target.id)).toEqual(before);
    expect(await listAllAssignments()).toEqual(allRowsBefore);
    expect(await listAllAuditEntries()).toEqual([]);
  });

  it('does not change the status of a mirrored person either', async () => {
    await setMirroredAccess(target.id, { role: 'viewer', tenantId: MIRROR_TENANT, objectId: ACCOUNT, scopes: [], at: '2026-06-01T00:00:00.000Z' });
    const before = await stored(target.id);
    await previewOf(target.id);
    expect(await stored(target.id)).toEqual(before);
  });

  it('names the other people already linked to the account, and not the person being linked', async () => {
    const other = await makeUser('other@example.com', 'editor');
    await setMirroredAccess(other.id, { role: 'editor', tenantId: MIRROR_TENANT, objectId: ACCOUNT.toUpperCase(), scopes: [], at: '2026-06-01T00:00:00.000Z' });
    const elsewhere = await makeUser('elsewhere@example.com', 'viewer');
    await setMirroredAccess(elsewhere.id, { role: 'viewer', tenantId: MIRROR_TENANT, objectId: OTHER_ACCOUNT, scopes: [], at: '2026-06-01T00:00:00.000Z' });

    const body = await (await previewOf(target.id)).json();
    expect(body.alsoLinkedTo).toEqual([{ id: other.id, email: 'other@example.com' }]);

    await setMirroredAccess(target.id, { role: 'viewer', tenantId: MIRROR_TENANT, objectId: ACCOUNT, scopes: [], at: '2026-06-01T00:00:00.000Z' });
    expect((await (await previewOf(target.id)).json()).alsoLinkedTo).toEqual([{ id: other.id, email: 'other@example.com' }]);
  });
});

describe('PUT /api/users/[id]/mirror', () => {
  it('stores the result of its own server-side run: the source, the Role, the Linked account and the Scopes with origins', async () => {
    const res = await confirmOf(target.id, { objectId: ACCOUNT, role: 'editor' });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toMatchObject({ id: target.id, role: 'editor', accessSource: 'mirrored', linkedAccount: { objectId: ACCOUNT } });
    expect(body.mirror.error).toBeNull();
    expect(body.mirror.lastSuccessAt).not.toBeNull();
    const rows = await listAssignmentsFor(target.id);
    expect(rows.map(r => [r.tenantId, r.scope, r.role]).sort()).toEqual([
      [MIRROR_TENANT, MG_EXAMPLE, 'editor'], [MIRROR_TENANT, SUB_A, 'editor'], [MIRROR_TENANT, RG_ONE, 'editor'],
    ]);
    expect(JSON.parse(rows.find(r => r.scope === RG_ONE)!.origin!)).toEqual([{ roleName: 'Owner', throughGroup: true, eligible: false }]);
    expect(body.mirroredScopes.map((s: { scope: string }) => s.scope).sort()).toEqual([MG_EXAMPLE, SUB_A, RG_ONE]);
    expect(await linkColumns(target.id)).toMatchObject({ tenant: MIRROR_TENANT, object: ACCOUNT, error: null });
  });

  it('replaces any Manual access the person held', async () => {
    await setManualAccess(target.id, [{ tenantId: MIRROR_TENANT, scope: SUB_B, role: 'viewer' }]);
    await confirmOf(target.id);
    expect((await listAssignmentsFor(target.id)).map(r => r.scope)).not.toContain(SUB_B);
  });

  it('never reads the Scopes or the tenant from the body', async () => {
    await confirmOf(target.id, {
      objectId: ACCOUNT, role: 'viewer', tenantId: 'someone-elses-tenant', scopes: [{ scope: SUB_B, role: 'editor' }], access: [{ scope: '/', role: 'editor' }],
    });
    const rows = await listAssignmentsFor(target.id);
    expect(rows.map(r => r.scope)).not.toContain(SUB_B);
    expect(rows.map(r => r.scope)).not.toContain('/');
    expect(new Set(rows.map(r => r.tenantId))).toEqual(new Set([MIRROR_TENANT]));
    expect(new Set(rows.map(r => r.role))).toEqual(new Set(['viewer']));
  });

  it('keeps the person with no Scope, and records a success, when the account holds no assignment', async () => {
    azure.assignments = [];
    const body = await (await confirmOf(target.id)).json();
    expect(body).toMatchObject({ accessSource: 'mirrored' });
    expect(body.mirror.lastSuccessAt).not.toBeNull();
    expect(await listAssignmentsFor(target.id)).toEqual([]);
  });

  it('changes nothing and answers a stable error when its own run fails', async () => {
    await setManualAccess(target.id, [{ tenantId: MIRROR_TENANT, scope: SUB_B, role: 'viewer' }]);
    const before = await stored(target.id);
    azure.failWith = new Error(LEAK);

    const res = await confirmOf(target.id);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: MIRROR_FAILED_MESSAGE, code: 'failed' });
    expect(await stored(target.id)).toEqual(before);
    expect(await listAllAuditEntries()).toEqual([]);
  });

  it('reports the other people already linked to the account', async () => {
    const other = await makeUser('other@example.com', 'viewer');
    await setMirroredAccess(other.id, { role: 'viewer', tenantId: MIRROR_TENANT, objectId: ACCOUNT, scopes: [], at: '2026-06-01T00:00:00.000Z' });
    const body = await (await confirmOf(target.id)).json();
    expect(body.alsoLinkedTo).toEqual([{ id: other.id, email: 'other@example.com' }]);
  });

  it('refuses a role other than Viewer or Editor', async () => {
    for (const role of ['admin', 'owner', undefined]) {
      expect((await confirmOf(target.id, { objectId: ACCOUNT, role })).status, String(role)).toBe(400);
    }
    expect((await getUser(target.id))!.accessSource).toBe('manual');
  });
});

describe.each([
  ['preview', (id: string, objectId?: unknown) => previewOf(id, objectId)],
  ['confirm', (id: string, objectId?: unknown) => confirmOf(id, { objectId: objectId === undefined ? ACCOUNT : objectId, role: 'viewer' })],
] as const)('what %s refuses', (_name, call) => {
  it('refuses an object id that is not a GUID with a 400, and reads nothing', async () => {
    for (const objectId of ['not-a-guid', '', 42, null, `${ACCOUNT}x`, "00000000-0000-0000-0000-0000000000c1') or ('1'='1"]) {
      expect((await call(target.id, objectId)).status, String(objectId)).toBe(400);
    }
    expect(azure.calls).toEqual([]);
  });

  it('refuses an Admin target with a 400', async () => {
    const res = await call(admin.id);
    expect(res.status).toBe(400);
    expect(azure.calls).toEqual([]);
    expect((await getUser(admin.id))!.accessSource).toBeNull();
  });

  it('answers 404 for a person that does not exist', async () => {
    expect((await call('no-such-person')).status).toBe(404);
  });

  it('answers 503 with the not-connected message when Azure is not connected', async () => {
    mockTenant.mockRejectedValue(new AzureNotConfiguredError('RuleBeat has no Azure credential to scan with.'));
    const res = await call(target.id);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: NO_AZURE_CONNECTION_MESSAGE, code: 'azure_not_configured' });
  });

  it('answers 502 with a stable message that holds none of the error Azure threw', async () => {
    azure.failWith = new Error(LEAK);
    const res = await call(target.id);
    expect(res.status).toBe(502);
    const text = JSON.stringify(await res.json());
    expect(text).toContain(MIRROR_FAILED_MESSAGE);
    expect(text).not.toMatch(/AuthorizationFailed|00000000-aaaa|secret-sub|11111111/);
  });
});

describe('POST /api/users/[id]/mirror/refresh', () => {
  async function mirrored(): Promise<AppUser> {
    await confirmOf(target.id, { objectId: ACCOUNT, role: 'viewer' });
    return (await getUser(target.id))!;
  }

  it('replaces the rows and origins on success', async () => {
    await mirrored();
    azure.assignments = [{ objectId: ACCOUNT, scope: SUB_B, role: 'Owner', principalType: 'Group' }];

    const res = await refreshOf(target.id);
    expect(res.status).toBe(200);
    const body = await res.json();

    const rows = await listAssignmentsFor(target.id);
    expect(rows.map(r => [r.scope, r.role])).toEqual([[SUB_B, 'viewer']]);
    expect(JSON.parse(rows[0]!.origin!)).toEqual([{ roleName: 'Owner', throughGroup: true, eligible: false }]);
    expect(body.mirroredScopes).toEqual([{ scope: SUB_B, origins: [{ roleName: 'Owner', throughGroup: true, eligible: false }] }]);
    expect(body.mirror).toMatchObject({ error: null });
  });

  it('answers 502 with a stable message and the stored person when the read fails, keeping the last Scopes', async () => {
    const first = await mirrored();
    const rowsBefore = await listAssignmentsFor(target.id);
    azure.failWith = new Error(LEAK);

    const res = await refreshOf(target.id);
    expect(res.status).toBe(502);
    const body = await res.json();

    expect(body.error).toBe(MIRROR_FAILED_MESSAGE);
    expect(body).toMatchObject({ id: target.id, accessSource: 'mirrored', mirror: { lastSuccessAt: first.mirror!.lastSuccessAt, error: { code: 'failed' } } });
    expect(body.mirroredScopes).toHaveLength(3);
    expect(await listAssignmentsFor(target.id)).toEqual(rowsBefore);
    expect(JSON.stringify(body)).not.toMatch(/AuthorizationFailed|00000000-aaaa|secret-sub|11111111/);
  });

  it('answers 503 when Azure is not connected, and records the attempt', async () => {
    await mirrored();
    mockTenant.mockRejectedValue(new AzureNotConfiguredError('RuleBeat has no Azure credential to scan with.'));
    const res = await refreshOf(target.id);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'azure_not_configured', error: NO_AZURE_CONNECTION_MESSAGE });
    expect((await getUser(target.id))!.mirror!.error!.code).toBe('azure_not_configured');
  });

  it('refuses a person with Manual access', async () => {
    const res = await refreshOf(target.id);
    expect(res.status).toBe(400);
    expect(azure.calls).toEqual([]);
    expect(await auditFor('user.mirror_refresh')).toEqual([]);
  });

  it('refuses an Admin, and a person that does not exist', async () => {
    expect((await refreshOf(admin.id)).status).toBe(400);
    expect((await refreshOf('no-such-person')).status).toBe(404);
    expect(azure.calls).toEqual([]);
  });
});

describe('what the existing routes do to a mirrored person', () => {
  const access = (id: string, grants: unknown) => accessRoute.PUT(jsonRequest('PUT', { access: grants }), params(id));
  const role = (id: string, body: unknown) => userRoute.PUT(jsonRequest('PUT', body), params(id));

  beforeEach(async () => { await confirmOf(target.id, { objectId: ACCOUNT, role: 'viewer' }); });

  it('turns them manual, with exactly the Scopes sent, no Linked account, no origins and no status, when access is edited', async () => {
    const res = await access(target.id, [{ scope: SUB_B, role: 'editor' }]);
    expect(res.status).toBe(200);

    const after = (await getUser(target.id))!;
    expect(after).toMatchObject({ accessSource: 'manual', role: 'editor', linkedAccount: null, mirror: null });
    expect(await linkColumns(target.id)).toEqual(NO_LINK);
    const rows = await listAssignmentsFor(target.id);
    expect(rows.map(r => [r.scope, r.role, r.origin])).toEqual([[SUB_B, 'editor', null]]);
    expect(await (await accessRoute.GET(new Request('http://localhost/api/test'), params(target.id))).json())
      .toMatchObject({ accessSource: 'manual', linkedAccount: null, mirroredScopes: [] });
  });

  it('refuses a refresh once they are manual, and never reads Azure for them', async () => {
    await access(target.id, [{ scope: SUB_B, role: 'viewer' }]);
    azure.calls.length = 0;
    expect((await refreshOf(target.id)).status).toBe(400);
    expect(azure.calls).toEqual([]);
    expect((await listAssignmentsFor(target.id)).map(r => r.scope)).toEqual([SUB_B]);
  });

  it('keeps the source, the Linked account and the Scopes, and sets the new Role on every row, when a Viewer becomes an Editor', async () => {
    const before = await listAssignmentsFor(target.id);
    const res = await role(target.id, { role: 'editor' });
    expect(res.status).toBe(200);

    const after = (await getUser(target.id))!;
    expect(after).toMatchObject({ accessSource: 'mirrored', role: 'editor', linkedAccount: { objectId: ACCOUNT } });
    const rows = await listAssignmentsFor(target.id);
    expect(rows.map(r => r.scope).sort()).toEqual(before.map(r => r.scope).sort());
    expect(new Set(rows.map(r => r.role))).toEqual(new Set(['editor']));
    expect(rows.map(r => r.origin).sort()).toEqual(before.map(r => r.origin).sort());
    expect(after.mirror).toEqual((await getUser(target.id))!.mirror);
  });

  it('removes the rows, the source, the Linked account and the status on promotion to Admin', async () => {
    const res = await role(target.id, { role: 'admin' });
    expect(res.status).toBe(200);

    const after = (await getUser(target.id))!;
    expect(after).toMatchObject({ role: 'admin', accessSource: null, linkedAccount: null, mirror: null });
    expect(await linkColumns(target.id)).toEqual(NO_LINK);
    expect(await listAssignmentsFor(target.id)).toEqual([]);
  });
});

describe('the audit log', () => {
  /** What an entry may not hold: an object id, a tenant id, a Scope path, a role name from Azure. */
  const FORBIDDEN = /0000|\/subscriptions|\/providers|Reader|Owner|Contributor/;

  function expectNamesOnly(entry: { summary: string; details: Record<string, unknown> | null }, changed: string[]) {
    expect(entry.details).toEqual({ changed });
    expect(entry.summary).not.toMatch(FORBIDDEN);
    expect(JSON.stringify(entry.details)).not.toMatch(FORBIDDEN);
  }

  it('writes one entry for a confirm, with field names only', async () => {
    await confirmOf(target.id);
    const entries = await auditFor('user.mirror_set');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ entityType: 'user', entityId: target.id, summary: 'Gave target@example.com Mirrored access' });
    expectNamesOnly(entries[0]!, ['accessSource', 'assignments', 'linkedAccount']);
  });

  it('writes one entry for a refresh that works and one for a refresh that fails, neither holding the error', async () => {
    await confirmOf(target.id);
    azure.assignments = [];
    await refreshOf(target.id);
    azure.failWith = new Error(LEAK);
    await refreshOf(target.id);

    const entries = (await auditFor('user.mirror_refresh')).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    expect(entries.map(e => e.summary).sort()).toEqual([
      'Refreshed the Mirrored access of target@example.com',
      'Tried to refresh the Mirrored access of target@example.com and it failed',
    ]);
    for (const entry of entries) expect(JSON.stringify(entry)).not.toMatch(/AuthorizationFailed|secret-sub|00000000-aaaa/);
    const worked = entries.find(e => e.summary.startsWith('Refreshed'))!;
    const failed = entries.find(e => e.summary.startsWith('Tried'))!;
    expectNamesOnly(worked, ['assignments']);
    expectNamesOnly(failed, []);
  });

  it('writes one entry for the switch to manual, and for each Role change', async () => {
    await confirmOf(target.id);
    await userRoute.PUT(jsonRequest('PUT', { role: 'editor' }), params(target.id));
    await userRoute.PUT(jsonRequest('PUT', { role: 'admin' }), params(target.id));
    const turned = await makeUser('turned@example.com', 'viewer');
    await confirmOf(turned.id);
    await accessRoute.PUT(jsonRequest('PUT', { access: [{ scope: SUB_B, role: 'viewer' }] }), params(turned.id));

    const roleChanges = await auditFor('user.role_change');
    expect(roleChanges).toHaveLength(2);
    expectNamesOnly(roleChanges.find(e => e.summary.includes('to editor'))!, ['role', 'assignments']);
    expectNamesOnly(roleChanges.find(e => e.summary.includes('to admin'))!, ['role', 'accessSource', 'assignments', 'linkedAccount']);

    const switched = await auditFor('user.access_change');
    expect(switched).toHaveLength(1);
    expectNamesOnly(switched[0]!, ['accessSource', 'assignments', 'linkedAccount']);
  });
});

describe('who may use the routes', () => {
  it.each(['viewer', 'editor'] as const)('refuses a %s with a 403 on all three, and never reads Azure', async (who) => {
    const person = await makeUser(`${who}@example.com`, who);
    signInAs(person);

    expect((await previewOf(target.id)).status).toBe(403);
    expect((await confirmOf(target.id)).status).toBe(403);
    expect((await refreshOf(target.id)).status).toBe(403);
    expect(azure.calls).toEqual([]);
    expect((await getUser(target.id))!.accessSource).toBe('manual');
  });

  it('answers 401 with no session', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await previewOf(target.id)).status).toBe(401);
    expect((await confirmOf(target.id)).status).toBe(401);
    expect((await refreshOf(target.id)).status).toBe(401);
    expect(azure.calls).toEqual([]);
  });
});

describe('a thrown Azure error', () => {
  it('is in no response body of any of the three routes', async () => {
    azure.failWith = new Error(LEAK);
    await confirmOf(target.id).catch(() => undefined);
    azure.failWith = null;
    await confirmOf(target.id);
    azure.failWith = new Error(LEAK);

    const bodies = [
      await (await previewOf(target.id)).text(),
      await (await confirmOf(target.id)).text(),
      await (await refreshOf(target.id)).text(),
    ];
    for (const body of bodies) {
      expect(body).not.toContain('AuthorizationFailed');
      expect(body).not.toContain('secret-sub');
      expect(body).not.toContain('00000000-aaaa');
      expect(body).not.toContain('correlation');
    }
    expect(bodies.every(b => b.includes('could not be read'))).toBe(true);
  });
});
