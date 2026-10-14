/**
 * #278: the access mirror. A Linked account's Azure role assignments go in through a fake reader and Scopes
 * with their origins come out, so every case here reads what Azure would have said, never Azure. The clock
 * and the wait are injected, so a throttled read backs off without a real timer. The refresh paths run over
 * the real repositories and the temp database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import {
  ACCOUNT, MG_EXAMPLE, MG_ROOT, MIRROR_TENANT, OTHER_ACCOUNT, SUB_A, SUB_B, fakeRoleAssignments, placesCalled,
  type FakeRoleAssignments,
} from '../helpers/fake-role-assignments';
import { AzureNotConfiguredError } from '@/lib/azure-credential';
import { MAX_READ_ATTEMPTS, MAX_RETRY_WAIT_MS, mirrorAccount, refreshMirroredUser } from '@/lib/access-mirror';
import { scopesFromAssignments } from '@/lib/access-mirror-model';
import { createUser, getUser, setManualAccess, setMirroredAccess, updateUserRole, type AppUser } from '@/lib/db/users';
import { listAssignmentsFor } from '@/lib/db/role-assignments';
import { parseScope } from '@/lib/access-model';

const mockTenant = vi.fn();
vi.mock('@/lib/arm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/arm')>()),
  getArmTenantId: () => mockTenant(),
}));

const RG_ONE = `${SUB_A}/resourceGroups/rg-one`;
const AT = new Date('2026-06-02T00:00:00.000Z');
const LATER = new Date('2026-06-02T01:00:00.000Z');

let azure: FakeRoleAssignments;
const waits: number[] = [];
const wait = async (ms: number): Promise<void> => { waits.push(ms); };

const run = (objectId = ACCOUNT) => mirrorAccount(objectId, { read: azure.read, wait });

async function scopesOf(objectId = ACCOUNT) {
  const result = await run(objectId);
  if (!result.ok) throw new Error('the fake mirror failed');
  return result.scopes;
}

beforeEach(async () => {
  await resetDb();
  mockTenant.mockReset();
  mockTenant.mockResolvedValue(MIRROR_TENANT);
  waits.length = 0;
  azure = fakeRoleAssignments();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('reading the Linked account', () => {
  it('asks for active assignments and for PIM eligibility once per subscription and once per management group', async () => {
    await run();

    const places = [SUB_A, SUB_B, MG_ROOT, MG_EXAMPLE];
    expect(placesCalled(azure, 'listActive')).toEqual(places);
    expect(placesCalled(azure, 'listEligible')).toEqual(places);
    expect(azure.calls.filter(c => c.method === 'listScopes')).toHaveLength(1);
  });

  it('asks about the Linked account and no one else', async () => {
    await run();
    const asked = azure.calls.filter(c => c.objectId !== undefined).map(c => c.objectId);
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked)).toEqual(new Set([ACCOUNT]));
  });

  it('merges the answers into one list with each Scope held once, however many places returned it', async () => {
    azure.assignments = [
      { objectId: ACCOUNT, scope: RG_ONE, role: 'Reader' },
      { objectId: ACCOUNT, scope: SUB_B, role: 'Contributor' },
      { objectId: ACCOUNT, scope: MG_EXAMPLE, role: 'Reader' },
    ];
    const scopes = await scopesOf();

    // The management group assignment is inherited by both subscriptions, so four places return it.
    expect(scopes.map(s => s.scope)).toEqual([MG_EXAMPLE, RG_ONE, SUB_B]);
  });

  it('gives a Scope for a direct assignment and for one inherited through a group, and marks only the second', async () => {
    azure.assignments = [
      { objectId: ACCOUNT, scope: SUB_A, role: 'Reader', principalType: 'User' },
      { objectId: ACCOUNT, scope: SUB_B, role: 'Reader', principalType: 'Group' },
      { objectId: ACCOUNT, scope: RG_ONE, role: 'Reader', principalType: 'ForeignGroup' },
    ];
    const byScope = Object.fromEntries((await scopesOf()).map(s => [s.scope, s.origins]));

    expect(byScope[SUB_A]).toEqual([{ roleName: 'Reader', throughGroup: false, eligible: false }]);
    expect(byScope[SUB_B]).toEqual([{ roleName: 'Reader', throughGroup: true, eligible: false }]);
    expect(byScope[RG_ONE]).toEqual([{ roleName: 'Reader', throughGroup: true, eligible: false }]);
  });

  it('marks an eligibility held through a group by its member type, and a direct one not', async () => {
    azure.assignments = [
      { objectId: ACCOUNT, scope: SUB_A, role: 'Reader', eligible: true, memberType: 'Group' },
      { objectId: ACCOUNT, scope: SUB_B, role: 'Reader', eligible: true, memberType: 'Direct' },
    ];
    const byScope = Object.fromEntries((await scopesOf()).map(s => [s.scope, s.origins]));

    expect(byScope[SUB_A]).toEqual([{ roleName: 'Reader', throughGroup: true, eligible: true }]);
    expect(byScope[SUB_B]).toEqual([{ roleName: 'Reader', throughGroup: false, eligible: true }]);
  });

  it('gives a Scope to an account that is only eligible at it', async () => {
    azure.assignments = [{ objectId: ACCOUNT, scope: SUB_A, role: 'Owner', eligible: true }];
    expect(await scopesOf()).toEqual([
      { scope: SUB_A, origins: [{ roleName: 'Owner', throughGroup: false, eligible: true }] },
    ]);
  });

  it('keeps every Azure role that gave one Scope, active and eligible, once each', async () => {
    azure.assignments = [
      { objectId: ACCOUNT, scope: SUB_A, role: 'Reader' },
      { objectId: ACCOUNT, scope: SUB_A, role: 'Reader' },
      { objectId: ACCOUNT, scope: SUB_A, role: 'Owner', eligible: true },
    ];
    expect(await scopesOf()).toEqual([{
      scope: SUB_A,
      origins: [
        { roleName: 'Owner', throughGroup: false, eligible: true },
        { roleName: 'Reader', throughGroup: false, eligible: false },
      ],
    }]);
  });

  it('gives a role on a single resource the resource group it sits in', async () => {
    azure.assignments = [
      { objectId: ACCOUNT, scope: `${RG_ONE}/providers/Microsoft.Compute/virtualMachines/vm-one`, role: 'Virtual Machine Contributor' },
    ];
    expect(await scopesOf()).toEqual([
      { scope: RG_ONE, origins: [{ roleName: 'Virtual Machine Contributor', throughGroup: false, eligible: false }] },
    ]);
  });

  it('gives no Scope for a path with no resource group that is neither a management group nor a subscription', async () => {
    azure.assignments = [
      { objectId: ACCOUNT, scope: `${SUB_A}/providers/Microsoft.Authorization/something`, role: 'Reader' },
      { objectId: ACCOUNT, scope: '/providers/Microsoft.Subscription/aliases/one', role: 'Reader' },
    ];
    expect(await scopesOf()).toEqual([]);
  });

  it('is not changed by a deny assignment: it neither removes a Scope nor adds one, and none is ever asked for', async () => {
    azure.assignments = [{ objectId: ACCOUNT, scope: SUB_A, role: 'Reader' }];
    const without = await scopesOf();

    azure.denies = [{ objectId: ACCOUNT, scope: SUB_A }, { objectId: ACCOUNT, scope: SUB_B }];
    azure.calls.length = 0;
    const withDeny = await scopesOf();

    expect(withDeny).toEqual(without);
    expect(withDeny.map(s => s.scope)).toEqual([SUB_A]);
    expect(azure.calls.filter(c => c.method === 'listDenyAssignments')).toEqual([]);
  });

  it('gives the tenant root management group as a Scope for a role held there', async () => {
    azure.assignments = [{ objectId: ACCOUNT, scope: MG_ROOT, role: 'Reader' }];
    const scopes = await scopesOf();
    expect(scopes.map(s => s.scope)).toEqual([MG_ROOT]);
    expect(parseScope(scopes[0]!.scope)?.kind).toBe('managementGroup');
  });

  it('never gives Everything or the Directory, whatever Azure holds, an assignment at the root path included', async () => {
    azure.assignments = [
      { objectId: ACCOUNT, scope: '/', role: 'Owner' },
      { objectId: ACCOUNT, scope: '/', role: 'Owner', eligible: true },
      { objectId: ACCOUNT, scope: MG_ROOT, role: 'Owner' },
      { objectId: ACCOUNT, scope: SUB_A, role: 'Owner' },
      { objectId: ACCOUNT, scope: '@directory', role: 'Owner' },
    ];
    const kinds = (await scopesOf()).map(s => parseScope(s.scope)?.kind);

    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds).not.toContain('everything');
    expect(kinds).not.toContain('directory');
    expect(kinds).not.toContain(undefined);
  });

  it('does not take another account\'s assignments', async () => {
    azure.assignments = [
      { objectId: OTHER_ACCOUNT, scope: SUB_A, role: 'Reader' },
      { objectId: ACCOUNT, scope: SUB_B, role: 'Reader' },
    ];
    expect((await scopesOf()).map(s => s.scope)).toEqual([SUB_B]);
  });

  it('gives no Scope for the root path or the Directory marker, in any spelling, and never Everything or the Directory', () => {
    const named = (scope: string) => ({ scope, roleName: 'Owner', eligible: false, principalType: null, memberType: null });
    for (const scope of ['/', '//', '@directory', '@DIRECTORY', '', '   ']) {
      expect(scopesFromAssignments([named(scope)]), JSON.stringify(scope)).toEqual([]);
    }
    const kept = scopesFromAssignments([named('/'), named('@directory'), named(MG_ROOT), named(`${SUB_A}/`)]);
    expect(kept.map(s => s.scope)).toEqual([MG_ROOT, SUB_A]);
    expect(kept.map(s => parseScope(s.scope)?.kind)).toEqual(['managementGroup', 'subscription']);
  });

  it('merges two spellings of one Scope into one, keeping the first casing', () => {
    const scopes = scopesFromAssignments([
      { scope: SUB_A.toUpperCase(), roleName: 'Reader', eligible: false, principalType: null, memberType: null },
      { scope: SUB_A, roleName: 'Owner', eligible: false, principalType: null, memberType: null },
    ]);
    expect(scopes).toHaveLength(1);
    expect(scopes[0]!.scope).toBe(SUB_A.toUpperCase());
    expect(scopes[0]!.origins.map(o => o.roleName)).toEqual(['Owner', 'Reader']);
  });

  it('answers with the tenant id RuleBeat resolved, and no tenant of Azure\'s or a request\'s', async () => {
    azure.assignments = [{ objectId: ACCOUNT, scope: SUB_A, role: 'Reader' }];
    const result = await run();
    expect(result).toMatchObject({ ok: true, tenantId: MIRROR_TENANT, objectId: ACCOUNT });
  });
});

describe('what a person holds once they are mirrored', () => {
  async function person(role: 'viewer' | 'editor' = 'viewer'): Promise<AppUser> {
    const created = await createUser({ email: `${role}@example.com`, role });
    if ('error' in created) throw new Error(created.error);
    return created.user;
  }

  it('stores every Scope under the resolved tenant at the one Role the Admin picked, whatever the Azure role is called', async () => {
    azure.assignments = [
      { objectId: ACCOUNT, scope: SUB_A, role: 'Owner' },
      { objectId: ACCOUNT, scope: RG_ONE.replace('rg-one', 'rg-two'), role: 'Contributor' },
      { objectId: ACCOUNT, scope: MG_EXAMPLE, role: 'Reader', eligible: true },
    ];
    const viewer = await person('viewer');
    const result = await run();
    if (!result.ok) throw new Error('the fake mirror failed');
    await setMirroredAccess(viewer.id, { role: 'viewer', tenantId: result.tenantId, objectId: ACCOUNT, scopes: result.scopes, at: AT.toISOString() });

    const rows = await listAssignmentsFor(viewer.id);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map(r => r.tenantId))).toEqual(new Set([MIRROR_TENANT]));
    expect(new Set(rows.map(r => r.role))).toEqual(new Set(['viewer']));
    expect(JSON.parse(rows.find(r => r.scope === SUB_A)!.origin!)).toEqual([{ roleName: 'Owner', throughGroup: false, eligible: false }]);
  });

  it('leaves the person mirrored with no Scope, and records a success, when Azure holds no assignment for the account', async () => {
    azure.assignments = [{ objectId: OTHER_ACCOUNT, scope: SUB_A, role: 'Reader' }];
    const editor = await person('editor');
    await setMirroredAccess(editor.id, {
      role: 'editor', tenantId: MIRROR_TENANT, objectId: ACCOUNT, at: AT.toISOString(),
      scopes: [{ scope: SUB_A, origins: [{ roleName: 'Reader', throughGroup: false, eligible: false }] }],
    });

    const outcome = await refreshMirroredUser((await getUser(editor.id))!, { read: azure.read, wait, now: () => LATER });

    expect(outcome).toEqual({ ok: true, stale: false });
    const after = (await getUser(editor.id))!;
    expect(await listAssignmentsFor(editor.id)).toEqual([]);
    expect(after).toMatchObject({ accessSource: 'mirrored', role: 'editor' });
    expect(after.mirror).toEqual({ lastSuccessAt: LATER.toISOString(), lastAttemptAt: LATER.toISOString(), error: null });
  });

  it('replaces the rows and origins on a successful refresh, at the Role the person holds now', async () => {
    azure.assignments = [{ objectId: ACCOUNT, scope: SUB_A, role: 'Reader' }];
    const viewer = await person('viewer');
    await setMirroredAccess(viewer.id, { role: 'viewer', tenantId: MIRROR_TENANT, objectId: ACCOUNT, scopes: [], at: AT.toISOString() });
    await updateUserRole(viewer.id, 'editor');

    azure.assignments = [{ objectId: ACCOUNT, scope: SUB_B, role: 'Owner', principalType: 'Group' }];
    await refreshMirroredUser((await getUser(viewer.id))!, { read: azure.read, wait, now: () => LATER });

    const rows = await listAssignmentsFor(viewer.id);
    expect(rows.map(r => [r.scope, r.role])).toEqual([[SUB_B, 'editor']]);
    expect(JSON.parse(rows[0]!.origin!)).toEqual([{ roleName: 'Owner', throughGroup: true, eligible: false }]);
  });
});

describe('a refresh that fails', () => {
  async function mirroredPerson() {
    azure.assignments = [{ objectId: ACCOUNT, scope: SUB_A, role: 'Reader' }];
    const created = await createUser({ email: 'viewer@example.com', role: 'viewer' });
    if ('error' in created) throw new Error(created.error);
    const first = await run();
    if (!first.ok) throw new Error('the fake mirror failed');
    await setMirroredAccess(created.user.id, {
      role: 'viewer', tenantId: first.tenantId, objectId: ACCOUNT, scopes: first.scopes, at: AT.toISOString(),
    });
    return (await getUser(created.user.id))!;
  }

  it('does not throw when the reader throws, and leaves the rows and the last success as they were', async () => {
    const viewer = await mirroredPerson();
    const rowsBefore = await listAssignmentsFor(viewer.id);

    azure.failWith = new Error('AuthorizationFailed: client 00000000-aaaa-bbbb-cccc-000000000000');
    const outcome = await refreshMirroredUser(viewer, { read: azure.read, wait, now: () => LATER });

    expect(outcome).toMatchObject({ ok: false, stale: false, error: { code: 'failed' } });
    expect(await listAssignmentsFor(viewer.id)).toEqual(rowsBefore);
    const after = (await getUser(viewer.id))!;
    expect(after.mirror).toEqual({
      lastSuccessAt: AT.toISOString(),
      lastAttemptAt: LATER.toISOString(),
      error: expect.objectContaining({ code: 'failed' }),
    });
  });

  it('records the code, never Azure\'s text', async () => {
    const viewer = await mirroredPerson();
    azure.failWith = new Error('AuthorizationFailed: client 00000000-aaaa-bbbb-cccc-000000000000');
    await refreshMirroredUser(viewer, { read: azure.read, wait, now: () => LATER });

    const stored = (await getUser(viewer.id))!.mirror!.error!;
    expect(JSON.stringify(stored)).not.toMatch(/AuthorizationFailed|00000000-aaaa/);
  });

  it('records azure_not_configured when Azure is not connected', async () => {
    const viewer = await mirroredPerson();
    mockTenant.mockRejectedValue(new AzureNotConfiguredError('RuleBeat has no Azure credential to scan with.'));
    const outcome = await refreshMirroredUser(viewer, { read: azure.read, wait, now: () => LATER });

    expect(outcome).toMatchObject({ ok: false, error: { code: 'azure_not_configured' } });
    expect((await getUser(viewer.id))!.mirror!.error!.code).toBe('azure_not_configured');
  });

  it('clears the failure again on the next refresh that works', async () => {
    const viewer = await mirroredPerson();
    azure.failWith = new Error('boom');
    await refreshMirroredUser(viewer, { read: azure.read, wait, now: () => LATER });
    azure.failWith = null;
    await refreshMirroredUser((await getUser(viewer.id))!, { read: azure.read, wait, now: () => LATER });

    expect((await getUser(viewer.id))!.mirror).toEqual({ lastSuccessAt: LATER.toISOString(), lastAttemptAt: LATER.toISOString(), error: null });
  });

  it('writes nothing when the person was turned manual while the read was in flight', async () => {
    const viewer = await mirroredPerson();
    const slow = {
      ...azure.read,
      listScopes: async () => {
        await setManualAccess(viewer.id, [{ tenantId: MIRROR_TENANT, scope: SUB_B, role: 'viewer' }]);
        return azure.read.listScopes();
      },
    };
    const outcome = await refreshMirroredUser(viewer, { read: slow as typeof azure.read, wait, now: () => LATER });

    expect(outcome).toEqual({ ok: true, stale: true });
    const after = (await getUser(viewer.id))!;
    expect(after).toMatchObject({ accessSource: 'manual', linkedAccount: null, mirror: null });
    expect((await listAssignmentsFor(viewer.id)).map(r => [r.scope, r.origin])).toEqual([[SUB_B, null]]);
  });

  it('writes no failure either when the person was turned manual while the read was in flight', async () => {
    const viewer = await mirroredPerson();
    azure.failWith = new Error('boom');
    const slow = {
      ...azure.read,
      listScopes: async () => {
        await setManualAccess(viewer.id, [{ tenantId: MIRROR_TENANT, scope: SUB_B, role: 'viewer' }]);
        return azure.read.listScopes();
      },
    };
    const outcome = await refreshMirroredUser(viewer, { read: slow as typeof azure.read, wait, now: () => LATER });

    expect(outcome).toMatchObject({ ok: false, stale: true });
    expect((await getUser(viewer.id))!.mirror).toBeNull();
  });
});

describe('a throttled read', () => {
  beforeEach(() => {
    azure.assignments = [{ objectId: ACCOUNT, scope: SUB_A, role: 'Reader' }];
  });

  it('waits as long as Azure asked through the injected wait, then asks again and succeeds', async () => {
    azure.throttle = { times: 2, retryAfterMs: 7000 };
    const result = await run();

    expect(waits).toEqual([7000, 7000]);
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.scopes.map(s => s.scope)).toEqual([SUB_A]);
  });

  it('is a failed refresh, coded as throttled, after a bounded number of tries', async () => {
    azure.throttle = { times: 1000, retryAfterMs: 1000 };
    const result = await run();

    expect(result).toMatchObject({ ok: false, error: { code: 'throttled' } });
    expect(waits).toHaveLength(MAX_READ_ATTEMPTS - 1);
    expect(azure.calls.filter(c => c.method === 'listScopes')).toHaveLength(MAX_READ_ATTEMPTS);
  });

  it('does not wait out a delay longer than a request can afford, and fails as throttled at once', async () => {
    azure.throttle = { times: 1, retryAfterMs: MAX_RETRY_WAIT_MS + 1 };
    const result = await run();

    expect(result).toMatchObject({ ok: false, error: { code: 'throttled' } });
    expect(waits).toEqual([]);
  });

  it('keeps the person\'s rows and records the attempt when the refresh gives up', async () => {
    const created = await createUser({ email: 'viewer@example.com', role: 'viewer' });
    if ('error' in created) throw new Error(created.error);
    await setMirroredAccess(created.user.id, {
      role: 'viewer', tenantId: MIRROR_TENANT, objectId: ACCOUNT, at: AT.toISOString(),
      scopes: [{ scope: SUB_B, origins: [{ roleName: 'Reader', throughGroup: false, eligible: false }] }],
    });
    azure.throttle = { times: 1000, retryAfterMs: 1000 };
    const outcome = await refreshMirroredUser((await getUser(created.user.id))!, { read: azure.read, wait, now: () => LATER });

    expect(outcome).toMatchObject({ ok: false, error: { code: 'throttled' } });
    expect((await listAssignmentsFor(created.user.id)).map(r => r.scope)).toEqual([SUB_B]);
    expect((await getUser(created.user.id))!.mirror).toMatchObject({ lastSuccessAt: AT.toISOString(), error: { code: 'throttled' } });
  });
});
