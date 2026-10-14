import { describe, expect, it } from 'vitest';
import type { AccessToken, TokenCredential } from '@azure/identity';
import { RoleAssignmentsClient, RoleAssignmentsThrottledError } from '../../src/clients/role-assignments.js';

/**
 * The read-only role assignments client (#278), over a faked `fetch`: which URLs it asks for, that it
 * follows `nextLink`, and that a 429 which outlasts the retries comes back as a typed error with the delay
 * ARM asked for. No Azure call is made: the credential and the network are both fakes.
 */

const OBJECT_ID = '00000000-0000-0000-0000-0000000000c1';
const SUB = '/subscriptions/00000000-0000-0000-0000-00000000000a';
const MG = '/providers/Microsoft.Management/managementGroups/mg-example';

const credential: TokenCredential = {
  getToken: async (): Promise<AccessToken> => ({ token: 'fake-token', expiresOnTimestamp: Date.now() + 60_000 }),
};

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

function fakeFetch(answer: (url: string) => Response | Promise<Response>) {
  const urls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    return answer(url);
  }) as typeof fetch;
  return { urls, impl };
}

const NO_WAIT = { maxAttempts: 2, backoffMs: [0] };

function clientOver(fake: ReturnType<typeof fakeFetch>, extra: { subscriptions?: string[]; attempts?: number } = {}) {
  return new RoleAssignmentsClient(credential, {
    fetchImpl: fake.impl,
    retry: { ...NO_WAIT, maxAttempts: extra.attempts ?? NO_WAIT.maxAttempts },
    listSubscriptions: async () => extra.subscriptions ?? [],
  });
}

const row = (scope: string, extra: Record<string, string> = {}) => ({
  properties: { scope, roleDefinitionId: `${SUB}/providers/Microsoft.Authorization/roleDefinitions/r1`, ...extra },
});

describe('RoleAssignmentsClient', () => {
  it('asks for active assignments at a scope with the assignedTo filter, and reads each row', async () => {
    const fake = fakeFetch(() => json({ value: [row(`${SUB}/resourceGroups/rg-one`, { principalType: 'Group' })] }));
    const rows = await clientOver(fake).listActive(SUB, OBJECT_ID);

    expect(fake.urls).toEqual([
      `https://management.azure.com${SUB}/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&$filter=assignedTo('${OBJECT_ID}')`,
    ]);
    expect(rows).toEqual([{
      scope: `${SUB}/resourceGroups/rg-one`,
      roleDefinitionId: `${SUB}/providers/Microsoft.Authorization/roleDefinitions/r1`,
      principalType: 'Group',
      memberType: null,
    }]);
  });

  it('asks for PIM eligibility at a scope with the same filter and reads the member type', async () => {
    const fake = fakeFetch(() => json({ value: [row(MG, { memberType: 'Group' })] }));
    const rows = await clientOver(fake).listEligible(MG, OBJECT_ID);

    expect(fake.urls).toEqual([
      `https://management.azure.com${MG}/providers/Microsoft.Authorization/roleEligibilityScheduleInstances?api-version=2020-10-01&$filter=assignedTo('${OBJECT_ID}')`,
    ]);
    expect(rows[0]).toMatchObject({ scope: MG, memberType: 'Group', principalType: null });
  });

  it('follows nextLink until there is none and returns every page', async () => {
    const next = 'https://management.azure.com/page-two?token=abc';
    const fake = fakeFetch(url => (url === next
      ? json({ value: [row(`${SUB}/resourceGroups/rg-two`)] })
      : json({ value: [row(`${SUB}/resourceGroups/rg-one`)], nextLink: next })));
    const rows = await clientOver(fake).listActive(SUB, OBJECT_ID);

    expect(rows.map(r => r.scope)).toEqual([`${SUB}/resourceGroups/rg-one`, `${SUB}/resourceGroups/rg-two`]);
    expect(fake.urls).toHaveLength(2);
    expect(fake.urls[1]).toBe(next);
  });

  it('skips a row that carries no scope or role definition', async () => {
    const fake = fakeFetch(() => json({ value: [{ properties: { scope: SUB } }, { properties: {} }, {}] }));
    expect(await clientOver(fake).listActive(SUB, OBJECT_ID)).toEqual([]);
  });

  it('refuses an object id that is not a GUID before it reaches the filter', async () => {
    const fake = fakeFetch(() => json({ value: [] }));
    await expect(clientOver(fake).listActive(SUB, "x') or ('1'='1")).rejects.toThrow(/GUID/);
    expect(fake.urls).toEqual([]);
  });

  it('lists the subscriptions the credential sees and the management groups, following nextLink', async () => {
    const next = 'https://management.azure.com/groups-two';
    const fake = fakeFetch(url => (url === next
      ? json({ value: [{ name: 'mg-two' }] })
      : json({ value: [{ name: 'tenant-root' }, { name: 'mg-example' }], nextLink: next })));
    const scopes = await clientOver(fake, { subscriptions: ['00000000-0000-0000-0000-00000000000a'] }).listScopes();

    expect(scopes).toEqual({
      subscriptions: [SUB],
      managementGroups: [
        '/providers/Microsoft.Management/managementGroups/tenant-root',
        MG,
        '/providers/Microsoft.Management/managementGroups/mg-two',
      ],
    });
    expect(fake.urls[0]).toBe('https://management.azure.com/providers/Microsoft.Management/managementGroups?api-version=2020-05-01');
  });

  it('reads a role definition name, and null for one that no longer exists', async () => {
    const id = `${SUB}/providers/Microsoft.Authorization/roleDefinitions/r1`;
    const gone = `${SUB}/providers/Microsoft.Authorization/roleDefinitions/r2`;
    const fake = fakeFetch(url => (url.includes('/r1?')
      ? json({ properties: { roleName: 'Reader' } })
      : new Response('{}', { status: 404 })));
    const client = clientOver(fake);

    expect(await client.roleName(id)).toBe('Reader');
    expect(await client.roleName(gone)).toBeNull();
    expect(fake.urls[0]).toBe(`https://management.azure.com${id}?api-version=2022-04-01`);
  });

  it('throws the typed throttled error, with the delay ARM asked for, when 429 outlasts the retries', async () => {
    const fake = fakeFetch(() => new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }));
    // One attempt, so fetchWithRetry hands the 429 back without sleeping the 7s itself.
    const err = await clientOver(fake, { attempts: 1 }).listActive(SUB, OBJECT_ID).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RoleAssignmentsThrottledError);
    expect((err as RoleAssignmentsThrottledError).retryAfterMs).toBe(7000);
    expect(fake.urls).toHaveLength(1);
  });

  it('turns a throttled answer with no Retry-After into the default delay', async () => {
    const fake = fakeFetch(() => new Response('', { status: 429 }));
    const err = await clientOver(fake).listEligible(SUB, OBJECT_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RoleAssignmentsThrottledError);
    expect((err as RoleAssignmentsThrottledError).retryAfterMs).toBe(10_000);
  });

  it('throws a plain error for any other failed status', async () => {
    const fake = fakeFetch(() => new Response('denied', { status: 403 }));
    const err = await clientOver(fake).listActive(SUB, OBJECT_ID).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(RoleAssignmentsThrottledError);
    expect((err as Error).message).toContain('403');
  });

  it('never requests a deny assignment or a Microsoft Graph URL, whatever it reads', async () => {
    const fake = fakeFetch(url => (url.includes('managementGroups?')
      ? json({ value: [{ name: 'mg-example' }] })
      : json({ value: [row(SUB)] })));
    const client = clientOver(fake, { subscriptions: ['00000000-0000-0000-0000-00000000000a'] });
    const scopes = await client.listScopes();
    for (const scope of [...scopes.subscriptions, ...scopes.managementGroups]) {
      await client.listActive(scope, OBJECT_ID);
      await client.listEligible(scope, OBJECT_ID);
    }
    await client.roleName(`${SUB}/providers/Microsoft.Authorization/roleDefinitions/r1`);

    expect(fake.urls.length).toBeGreaterThan(5);
    for (const url of fake.urls) {
      expect(url).not.toMatch(/denyassignments/i);
      expect(url).not.toMatch(/graph\.microsoft\.com/i);
      expect(url.startsWith('https://management.azure.com/')).toBe(true);
    }
  });
});
