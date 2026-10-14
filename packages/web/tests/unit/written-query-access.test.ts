/**
 * #277: a query a person writes is limited by its request. Each test goes in at a route's `POST` with the
 * real `requireRole`, so only the session (`@/auth`) and `createTenantContext` are mocked, and asserts on
 * what the fake Azure recorded: the scope Resource Graph was sent, the Graph paths, the Log Analytics
 * queries. A refusal is a 403 with a stable message, before anything reaches Azure and with no audit entry
 * and no query run. Rows are never filtered and the KQL is never rewritten.
 *
 * Every id is fake: zero GUIDs and example.com.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { listAllAuditEntries } from '@/lib/db/audit';
import { listQueryRuns } from '@/lib/db/query-runs';
import { fakeTenantContext, TEST_SUB_A, TEST_SUB_B, TEST_TENANT_ID, type FakeTenantContext } from '../helpers/fake-azure';
import type { Role } from '@/lib/rbac';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

let fakeCtx: FakeTenantContext;
vi.mock('@/lib/azure-credential', async () => {
  const actual = await vi.importActual<typeof import('@/lib/azure-credential')>('@/lib/azure-credential');
  return { ...actual, createTenantContext: () => Promise.resolve(fakeCtx) };
});

const runResourceGraph = await import('@/app/api/query/run-resource-graph/route');
const validateKql = await import('@/app/api/rules/validate-kql/route');
const runMicrosoftGraph = await import('@/app/api/query/run-microsoft-graph/route');
const validateGraph = await import('@/app/api/rules/validate-graph/route');
const runLogAnalytics = await import('@/app/api/query/run-log-analytics/route');
const validateLogs = await import('@/app/api/rules/validate-logs/route');

const SUB_C = '33333333-3333-3333-3333-333333333333';
const MG = '/providers/Microsoft.Management/managementGroups/mg-example';
const SUBSCRIPTION_A = `/subscriptions/${TEST_SUB_A}`;
const SUBSCRIPTION_B = `/subscriptions/${TEST_SUB_B}`;
const GROUP_A = `/subscriptions/${TEST_SUB_A}/resourceGroups/rg-logs`;
const GROUP_OTHER = `/subscriptions/${TEST_SUB_A}/resourceGroups/rg-other`;
const GROUP_B = `/subscriptions/${TEST_SUB_B}/resourceGroups/rg-two`;
const DIRECTORY = '@directory';
const WORKSPACE_ID = 'workspace-customer-id';

const KQL = 'resources\n| where subscriptionId == "99999999-9999-9999-9999-999999999999"';
const GRAPH_QUERY = { path: 'users', filter: 'accountEnabled eq false' };
const LOGS_QUERY = { kql: 'SigninLogs | where ResultType != 0', timeWindowDays: 30 };

interface Held { scope: string; role: Role }

async function signInWith(held: Held[], role: Role = 'editor'): Promise<string> {
  const created = await createUser({
    email: `person-${Math.random().toString(36).slice(2)}@example.com`,
    role,
    access: held.map(h => ({ tenantId: TEST_TENANT_ID, scope: h.scope, role: h.role })),
  });
  if ('error' in created) throw new Error(created.error);
  mockAuth.mockResolvedValue({ user: { uid: created.user.id } });
  return created.user.id;
}

const editorOn = (...scopes: string[]) => signInWith(scopes.map(scope => ({ scope, role: 'editor' as const })));

function post(url: string, body: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

/** A fake whose workspace lookup answers with the given placement, or with nothing when it is null. */
function fakeWithWorkspace(placement: { subscriptionId: string; resourceGroup: string } | null): FakeTenantContext {
  return fakeTenantContext({
    logAnalyticsWorkspaceId: WORKSPACE_ID,
    rows: kql => kql.includes('operationalinsights/workspaces') && placement
      ? [{ id: 'workspace', customerId: WORKSPACE_ID, ...placement }]
      : [],
    logsRows: [{ user: 'a@example.com' }],
  });
}

interface RouteCase {
  name: string;
  send: () => Promise<Response>;
  /** Whether the fake recorded anything for this route's own query (not counting a workspace lookup). */
  reached: () => boolean;
}

const sendToResourceGraph = (extra: Record<string, unknown> = {}) =>
  runResourceGraph.POST(post('/api/query/run-resource-graph', { kql: KQL, ...extra }));

const ROUTES: RouteCase[] = [
  { name: 'run-resource-graph', send: () => sendToResourceGraph(), reached: () => fakeCtx.queries.length > 0 },
  { name: 'validate-kql', send: () => validateKql.POST(post('/api/rules/validate-kql', { kql: KQL })), reached: () => fakeCtx.queries.length > 0 },
  { name: 'run-microsoft-graph', send: () => runMicrosoftGraph.POST(post('/api/query/run-microsoft-graph', { graphQuery: GRAPH_QUERY })), reached: () => fakeCtx.graphRequests.length > 0 },
  { name: 'validate-graph', send: () => validateGraph.POST(post('/api/rules/validate-graph', { graphQuery: GRAPH_QUERY })), reached: () => fakeCtx.graphRequests.length > 0 },
  { name: 'run-log-analytics', send: () => runLogAnalytics.POST(post('/api/query/run-log-analytics', { logsQuery: LOGS_QUERY })), reached: () => fakeCtx.logsQueries.length > 0 },
  { name: 'validate-logs', send: () => validateLogs.POST(post('/api/rules/validate-logs', { logsQuery: LOGS_QUERY })), reached: () => fakeCtx.logsQueries.length > 0 },
];

const LOGS_ROUTES = ROUTES.filter(r => r.name.endsWith('log-analytics') || r.name === 'validate-logs');

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
  fakeCtx = fakeWithWorkspace({ subscriptionId: TEST_SUB_A, resourceGroup: 'rg-logs' });
});

async function expectRefused(res: Response, ...mustMention: string[]): Promise<string> {
  expect(res.status).toBe(403);
  const { error } = await res.json() as { error: string };
  for (const word of mustMention) expect(error.toLowerCase()).toContain(word);
  return error;
}

describe('Resource Graph: only the subscriptions and management groups a person holds', () => {
  it('sends an Editor on one subscription exactly that subscription, and the KQL as posted', async () => {
    await editorOn(SUBSCRIPTION_A);
    const res = await sendToResourceGraph();
    expect(res.status).toBe(200);
    expect(fakeCtx.queries).toEqual([{ kql: KQL, scope: { subscriptions: [TEST_SUB_A] } }]);
  });

  it('does the same on validate-kql, with the existing take 5 as the only addition to the KQL', async () => {
    await editorOn(SUBSCRIPTION_A);
    const res = await validateKql.POST(post('/api/rules/validate-kql', { kql: KQL }));
    expect(res.status).toBe(200);
    expect(fakeCtx.queries).toEqual([{ kql: `${KQL}\n| take 5`, scope: { subscriptions: [TEST_SUB_A] } }]);
  });

  it('sends a subscription and a management group both, and nothing else', async () => {
    await editorOn(SUBSCRIPTION_A, MG);
    await sendToResourceGraph();
    expect(fakeCtx.queries).toHaveLength(1);
    expect(fakeCtx.queries[0]!.scope).toEqual({ subscriptions: [TEST_SUB_A], managementGroups: ['mg-example'] });
  });

  it('sends only the held subscription when the request names one held and one outside', async () => {
    await editorOn(SUBSCRIPTION_A);
    await sendToResourceGraph({ scope: { level: 'resource', subscriptions: [TEST_SUB_B, TEST_SUB_A] } });
    expect(fakeCtx.queries[0]!.scope).toEqual({ subscriptions: [TEST_SUB_A] });
  });

  it('matches a requested subscription without regard to case', async () => {
    const lettered = 'abcdef12-aaaa-bbbb-cccc-1234567890ab';
    await editorOn(SUBSCRIPTION_A, `/subscriptions/${lettered}`);
    await sendToResourceGraph({ scope: { subscriptions: [lettered.toUpperCase()] } });
    expect(fakeCtx.queries[0]!.scope).toEqual({ subscriptions: [lettered] });
  });

  it('sends every held scope when the request names none', async () => {
    await editorOn(SUBSCRIPTION_A, SUBSCRIPTION_B);
    await sendToResourceGraph({ scope: { level: 'resource', subscriptions: [], managementGroups: [] } });
    expect(fakeCtx.queries[0]!.scope).toEqual({ subscriptions: [TEST_SUB_A, TEST_SUB_B] });
  });

  it('refuses a request that names nothing the person holds, with a stable message and no query', async () => {
    const userId = await editorOn(SUBSCRIPTION_A);
    const error = await expectRefused(await sendToResourceGraph({ scope: { subscriptions: [TEST_SUB_B] } }), 'none of the subscriptions');
    expect(error).not.toContain(TEST_SUB_B);
    expect(fakeCtx.queries).toEqual([]);
    expect(await listAllAuditEntries()).toEqual([]);
    expect(await listQueryRuns(userId)).toEqual([]);
  });

  it('refuses a requested management group the person does not hold', async () => {
    await editorOn(SUBSCRIPTION_A);
    await expectRefused(await sendToResourceGraph({ scope: { managementGroups: ['mg-example'] } }));
    expect(fakeCtx.queries).toEqual([]);
  });

  it('refuses a request whose scope entries are not text, rather than sending an empty scope', async () => {
    await editorOn(SUBSCRIPTION_A);
    await expectRefused(await sendToResourceGraph({ scope: { subscriptions: [TEST_SUB_B, 7, null] } }));
    expect(fakeCtx.queries).toEqual([]);
  });

  it('sends KQL that names an outside subscription unchanged, with the person\'s own scope', async () => {
    await editorOn(SUBSCRIPTION_A);
    await sendToResourceGraph({ kql: `resources | where subscriptionId == "${SUB_C}"` });
    expect(fakeCtx.queries).toEqual([{ kql: `resources | where subscriptionId == "${SUB_C}"`, scope: { subscriptions: [TEST_SUB_A] } }]);
  });

  it('returns the rows Azure answered, untouched', async () => {
    await editorOn(SUBSCRIPTION_A);
    fakeCtx = fakeTenantContext({ rows: [{ id: 'x', subscriptionId: SUB_C }] });
    const body = await (await sendToResourceGraph()).json() as { rows: unknown[] };
    expect(body.rows).toEqual([{ id: 'x', subscriptionId: SUB_C }]);
  });

  it('does not count a subscription held only as a Viewer', async () => {
    await signInWith([{ scope: SUBSCRIPTION_B, role: 'viewer' }, { scope: SUBSCRIPTION_A, role: 'editor' }]);
    await sendToResourceGraph();
    expect(fakeCtx.queries[0]!.scope).toEqual({ subscriptions: [TEST_SUB_A] });
  });

  it('records the query run with the scope the person asked for', async () => {
    const userId = await editorOn(SUBSCRIPTION_A);
    await sendToResourceGraph({ scope: { level: 'resource', subscriptions: [TEST_SUB_A] } });
    const [run] = await listQueryRuns(userId);
    expect(run!.scope).toEqual({ level: 'resource', subscriptions: [TEST_SUB_A] });
  });
});

describe('a person whose access is only resource groups writes no query', () => {
  for (const route of ROUTES) {
    it(`is refused on ${route.name} with the subscription message, and nothing is recorded`, async () => {
      const userId = await editorOn(GROUP_A, GROUP_B);
      const error = await expectRefused(await route.send(), 'subscription');
      expect(error).not.toMatch(/rg-|[0-9a-f]{8}-[0-9a-f]{4}|\/subscriptions/i);
      expect(fakeCtx.queries).toEqual([]);
      expect(fakeCtx.graphRequests).toEqual([]);
      expect(fakeCtx.logsQueries).toEqual([]);
      expect(await listAllAuditEntries()).toEqual([]);
      expect(await listQueryRuns(userId)).toEqual([]);
    });
  }

  it('is not refused once they also hold a Scope that is not a resource group', async () => {
    await editorOn(GROUP_A, DIRECTORY);
    expect((await ROUTES[2]!.send()).status).toBe(200);
  });

  it('is still refused when the subscription is held only as a Viewer', async () => {
    await signInWith([{ scope: GROUP_A, role: 'editor' }, { scope: SUBSCRIPTION_A, role: 'viewer' }]);
    for (const route of ROUTES) expect((await route.send()).status, route.name).toBe(403);
    expect(fakeCtx.queries).toEqual([]);
    expect(fakeCtx.graphRequests).toEqual([]);
    expect(fakeCtx.logsQueries).toEqual([]);
  });
});

describe('Microsoft Graph needs the Directory', () => {
  const graphRoutes = ROUTES.filter(r => r.name === 'run-microsoft-graph' || r.name === 'validate-graph');

  for (const route of graphRoutes) {
    it(`refuses an Editor without the Directory on ${route.name}, before any Graph request`, async () => {
      const userId = await editorOn(SUBSCRIPTION_A);
      const error = await expectRefused(await route.send(), 'directory');
      expect(error).not.toContain(TEST_SUB_A);
      expect(fakeCtx.graphRequests).toEqual([]);
      expect(await listAllAuditEntries()).toEqual([]);
      expect(await listQueryRuns(userId)).toEqual([]);
    });

    it(`answers an Editor with the Directory on ${route.name}`, async () => {
      await editorOn(DIRECTORY);
      expect((await route.send()).status).toBe(200);
      expect(fakeCtx.graphRequests).toHaveLength(1);
    });

    it(`does not count a Directory held only as a Viewer on ${route.name}`, async () => {
      await signInWith([{ scope: DIRECTORY, role: 'viewer' }, { scope: SUBSCRIPTION_A, role: 'editor' }]);
      expect((await route.send()).status).toBe(403);
      expect(fakeCtx.graphRequests).toEqual([]);
    });
  }
});

describe('Log Analytics needs a Scope that covers the workspace\'s resource group', () => {
  for (const route of LOGS_ROUTES) {
    it(`refuses an Editor whose Scopes do not cover the workspace on ${route.name}`, async () => {
      const userId = await editorOn(SUBSCRIPTION_B);
      const error = await expectRefused(await route.send(), 'workspace');
      expect(error).not.toContain(TEST_SUB_A);
      expect(error).not.toContain('rg-logs');
      expect(fakeCtx.logsQueries).toEqual([]);
      expect(await listAllAuditEntries()).toEqual([]);
      expect(await listQueryRuns(userId)).toEqual([]);
    });

    it(`answers an Editor on the workspace's subscription on ${route.name}`, async () => {
      await editorOn(SUBSCRIPTION_A);
      expect((await route.send()).status).toBe(200);
      expect(fakeCtx.logsQueries).toEqual([LOGS_QUERY.kql]);
    });

    it(`answers an Editor on the workspace's resource group, who holds a second Scope, on ${route.name}`, async () => {
      await editorOn(GROUP_A, DIRECTORY);
      expect((await route.send()).status).toBe(200);
      expect(fakeCtx.logsQueries).toEqual([LOGS_QUERY.kql]);
    });

    it(`refuses an Editor on a different resource group of the same subscription on ${route.name}`, async () => {
      await editorOn(GROUP_OTHER, DIRECTORY);
      expect((await route.send()).status).toBe(403);
      expect(fakeCtx.logsQueries).toEqual([]);
    });

    it(`refuses anyone but Everything when the workspace cannot be placed, on ${route.name}`, async () => {
      fakeCtx = fakeWithWorkspace(null);
      await editorOn(SUBSCRIPTION_A);
      await expectRefused(await route.send(), 'workspace');
      expect(fakeCtx.logsQueries).toEqual([]);
    });

    it(`does not count a covering Scope held only as a Viewer on ${route.name}`, async () => {
      await signInWith([{ scope: SUBSCRIPTION_A, role: 'viewer' }, { scope: SUBSCRIPTION_B, role: 'editor' }]);
      expect((await route.send()).status).toBe(403);
      expect(fakeCtx.logsQueries).toEqual([]);
    });
  }
});

describe('Everything sends what it always sent', () => {
  for (const role of ['admin', 'editor'] as const) {
    it(`passes the requested scope through for ${role}, whole and untouched`, async () => {
      const created = await createUser({ email: `${role}@example.com`, role });
      if ('error' in created) throw new Error(created.error);
      mockAuth.mockResolvedValue({ user: { uid: created.user.id } });
      const scope = { level: 'resource', subscriptions: [SUB_C], managementGroups: ['any-group'] };
      await sendToResourceGraph({ scope });
      await sendToResourceGraph();
      expect(fakeCtx.queries).toEqual([{ kql: KQL, scope }, { kql: KQL, scope: undefined }]);
    });

    it(`reaches Graph and Logs for ${role} without a workspace lookup`, async () => {
      const created = await createUser({ email: `${role}2@example.com`, role });
      if ('error' in created) throw new Error(created.error);
      mockAuth.mockResolvedValue({ user: { uid: created.user.id } });
      for (const route of ROUTES.slice(2)) expect((await route.send()).status, route.name).toBe(200);
      expect(fakeCtx.queries).toEqual([]);
      expect(fakeCtx.graphRequests).toHaveLength(2);
      expect(fakeCtx.logsQueries).toHaveLength(2);
    });
  }

  it('sends validate-kql with no scope at all', async () => {
    const created = await createUser({ email: 'everything@example.com', role: 'editor' });
    if ('error' in created) throw new Error(created.error);
    mockAuth.mockResolvedValue({ user: { uid: created.user.id } });
    await validateKql.POST(post('/api/rules/validate-kql', { kql: KQL }));
    expect(fakeCtx.queries).toEqual([{ kql: `${KQL}\n| take 5`, scope: undefined }]);
  });
});
