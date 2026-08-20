/**
 * Spec 032 — POST /api/rules and PUT /api/rules/[id] must apply the same allowlist/shape/probe
 * guard to a microsoft-graph rule's graphQuery that spec 005's identity guard already applies to a
 * resource-graph rule's rawKql (see rules-route-identity-guard.test.ts and graph-rule-validation.ts).
 * The allowlist check in particular is the real security boundary (Frame §11 Q3 — Graph .default
 * permissions aren't Reader-scoped the way ARG is), so it must hold at the API layer even for a
 * request built by hand rather than through the picker UI.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { loadRules, saveRules } from '@/lib/rules';
import { fakeTenantContext } from '../helpers/fake-azure';
import type { FakeTenantContext } from '../helpers/fake-azure';
import type { GraphQuery, Rule } from '@rulebeat/core';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

let fakeCtx: FakeTenantContext | null;
let connectError: Error | null;
vi.mock('@/lib/azure-credential', () => ({
  createTenantContext: () => connectError ? Promise.reject(connectError) : Promise.resolve(fakeCtx),
}));

const { POST } = await import('@/app/api/rules/route');
const { PUT } = await import('@/app/api/rules/[id]/route');

function baseBody(overrides: Partial<Rule> = {}): Omit<Rule, 'id'> {
  return {
    name: 'test graph rule ' + Math.random().toString(36).slice(2),
    description: 'a test rule',
    category: 'identity',
    severity: 'medium',
    enabled: true,
    type: 'custom',
    scope: { level: 'resource' },
    resourceTypes: [],
    conditions: [],
    ...overrides,
  };
}

function postRequest(body: unknown): Request {
  return new Request('http://localhost/api/rules', { method: 'POST', body: JSON.stringify(body) });
}
function putRequest(body: unknown): Request {
  return new Request('http://localhost/api/rules/x', { method: 'PUT', body: JSON.stringify(body) });
}

async function signInAsEditor(): Promise<void> {
  const result = createUser({ email: 'editor@example.com', role: 'editor' });
  if ('error' in result) throw new Error(result.error);
  setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
  mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
}

const VALID_GQ: GraphQuery = { path: 'users', filter: 'accountEnabled eq false' };
const NON_ALLOWLISTED_GQ = { path: 'directoryObjects' } as unknown as GraphQuery;

describe('POST /api/rules — Graph backend guard (spec 032)', () => {
  beforeEach(async () => {
    resetDb();
    mockAuth.mockReset();
    connectError = null;
    fakeCtx = null;
    await signInAsEditor();
  });

  it('no longer blanket-rejects log-analytics as an unauthorable backend (spec 036)', async () => {
    // Log Analytics gained a real editor/engine in spec 036 — this used to 400 because the backend
    // itself was rejected outright. It still 400s here, but now for an ordinary validation reason
    // (no logsQuery on the request), not because the backend can't be authored. The full logsQuery
    // validation surface has its own dedicated coverage in rules-route-logs-guard.test.ts.
    const before = loadRules().length;
    const res = await POST(postRequest(baseBody({ queryBackend: 'log-analytics' })));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/needs a.*query/);
    expect(loadRules().length).toBe(before);
  });

  it('rejects a microsoft-graph rule with no graphQuery at all', async () => {
    const res = await POST(postRequest(baseBody({ queryBackend: 'microsoft-graph' })));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/Microsoft Graph query/);
  });

  it('rejects a microsoft-graph rule whose path is not on the allowlist, even sent directly (spec 032 Tests bullet 5)', async () => {
    const res = await POST(postRequest(baseBody({ queryBackend: 'microsoft-graph', graphQuery: NON_ALLOWLISTED_GQ })));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/not one of the Microsoft Graph resource types/);
  });

  it('rejects a microsoft-graph rule whose expand config is missing required fields', async () => {
    const badGq = {
      path: 'applications',
      expand: { arrayField: '', dateField: '', itemIdField: '', resourceType: '', bands: [] },
    } as unknown as GraphQuery;
    const res = await POST(postRequest(baseBody({ queryBackend: 'microsoft-graph', graphQuery: badGq })));
    expect(res.status).toBe(400);
  });

  it('saves a valid microsoft-graph rule, persisting queryBackend, graphQuery and kind:state', async () => {
    fakeCtx = fakeTenantContext({ graphRows: [{ id: 'u1', displayName: 'User One' }] });
    const res = await POST(postRequest(baseBody({ queryBackend: 'microsoft-graph', graphQuery: VALID_GQ })));
    expect(res.status).toBe(201);
    const json = await res.json();
    const saved = loadRules().find(r => r.id === json.id);
    expect(saved?.queryBackend).toBe('microsoft-graph');
    expect(saved?.graphQuery).toEqual(VALID_GQ);
    expect(saved?.kind).toBe('state');
    expect(fakeCtx?.graphRequests).toHaveLength(1);
  });

  it('fails open and still saves when the Graph probe cannot connect to Azure at all', async () => {
    connectError = new Error('no credential configured');
    const res = await POST(postRequest(baseBody({ queryBackend: 'microsoft-graph', graphQuery: VALID_GQ })));
    expect(res.status).toBe(201);
  });

  it('fails open and still saves when the Graph probe query itself throws', async () => {
    fakeCtx = fakeTenantContext({ graphFailWith: new Error('Graph API 429: throttled') });
    const res = await POST(postRequest(baseBody({ queryBackend: 'microsoft-graph', graphQuery: VALID_GQ })));
    expect(res.status).toBe(201);
  });

  it('defaults a request with no queryBackend to resource-graph, unaffected by the Graph guard', async () => {
    const res = await POST(postRequest(baseBody()));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(loadRules().find(r => r.id === json.id)?.queryBackend).toBe('resource-graph');
  });
});

describe('PUT /api/rules/[id] — Graph backend guard (spec 032)', () => {
  let customRuleId: string;
  let builtinGraphRuleId: string;

  beforeEach(async () => {
    resetDb();
    mockAuth.mockReset();
    connectError = null;
    fakeCtx = null;
    await signInAsEditor();

    customRuleId = globalThis.crypto.randomUUID();
    builtinGraphRuleId = globalThis.crypto.randomUUID();
    saveRules([
      ...loadRules(),
      {
        id: customRuleId,
        name: 'existing custom graph rule',
        description: 'a test rule',
        category: 'identity',
        severity: 'medium',
        enabled: true,
        type: 'custom',
        queryBackend: 'microsoft-graph',
        scope: { level: 'resource' },
        resourceTypes: [],
        conditions: [],
        graphQuery: VALID_GQ,
      },
      {
        id: builtinGraphRuleId,
        name: 'existing builtin graph rule',
        description: 'a test rule',
        category: 'identity',
        severity: 'medium',
        enabled: true,
        type: 'builtin',
        queryBackend: 'microsoft-graph',
        scope: { level: 'resource' },
        resourceTypes: [],
        conditions: [],
        graphQuery: VALID_GQ,
      },
    ]);
  });

  it('requires graphQuery on an edit to an existing microsoft-graph custom rule', async () => {
    const res = await PUT(
      putRequest({ ...baseBody(), id: customRuleId, graphQuery: undefined }),
      { params: Promise.resolve({ id: customRuleId }) },
    );
    expect(res.status).toBe(400);
  });

  it('rejects an edit whose new graphQuery path is not allowlisted, leaving the stored rule untouched (spec 032 Tests bullet 5)', async () => {
    const res = await PUT(
      putRequest({ ...baseBody(), id: customRuleId, graphQuery: NON_ALLOWLISTED_GQ }),
      { params: Promise.resolve({ id: customRuleId }) },
    );
    expect(res.status).toBe(400);
    expect(loadRules().find(r => r.id === customRuleId)?.graphQuery).toEqual(VALID_GQ);
  });

  it('saves an edit whose new graphQuery is valid', async () => {
    fakeCtx = fakeTenantContext({ graphRows: [] });
    const newGq: GraphQuery = { path: 'groups', filter: "startswith(displayName,'temp-')" };
    const res = await PUT(
      putRequest({ ...baseBody(), id: customRuleId, graphQuery: newGq }),
      { params: Promise.resolve({ id: customRuleId }) },
    );
    expect(res.status).toBe(200);
    expect(loadRules().find(r => r.id === customRuleId)?.graphQuery).toEqual(newGq);
  });

  it('allows editing graphQuery on a builtin microsoft-graph rule (Decision 1 — identity checks become fully editable)', async () => {
    fakeCtx = fakeTenantContext({ graphRows: [] });
    const newGq: GraphQuery = { path: 'applications', filter: "startswith(displayName,'internal-')" };
    const res = await PUT(
      putRequest({ enabled: true, graphQuery: newGq }),
      { params: Promise.resolve({ id: builtinGraphRuleId }) },
    );
    expect(res.status).toBe(200);
    expect(loadRules().find(r => r.id === builtinGraphRuleId)?.graphQuery).toEqual(newGq);
  });

  it('rejects an invalid-shape graphQuery edit on a builtin microsoft-graph rule, leaving it untouched', async () => {
    const res = await PUT(
      putRequest({ enabled: true, graphQuery: NON_ALLOWLISTED_GQ }),
      { params: Promise.resolve({ id: builtinGraphRuleId }) },
    );
    expect(res.status).toBe(400);
    expect(loadRules().find(r => r.id === builtinGraphRuleId)?.graphQuery).toEqual(VALID_GQ);
  });

  it('still allows an enabled-only edit on a builtin microsoft-graph rule with no graphQuery in the body', async () => {
    const res = await PUT(
      putRequest({ enabled: false }),
      { params: Promise.resolve({ id: builtinGraphRuleId }) },
    );
    expect(res.status).toBe(200);
    const saved = loadRules().find(r => r.id === builtinGraphRuleId);
    expect(saved?.enabled).toBe(false);
    expect(saved?.graphQuery).toEqual(VALID_GQ);
  });
});
