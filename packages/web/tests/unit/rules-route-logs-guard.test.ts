/**
 * Spec 036 — POST /api/rules and PUT /api/rules/[id] apply the same shape/probe guard to a
 * log-analytics rule's logsQuery that spec 032 already applies to a microsoft-graph rule's
 * graphQuery (see rules-route-graph-guard.test.ts and log-analytics-rule-validation.ts). There is
 * no allowlist here — Log Analytics has no Graph-style fixed resource-type set — so the guard is
 * purely shape validation (non-empty KQL, a sane time window, a non-blank optional dimension key)
 * plus a fail-open save-time probe, mirrored one-for-one from the Graph guard's own probe tests.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { loadRules, saveRules } from '@/lib/rules';
import { fakeTenantContext } from '../helpers/fake-azure';
import type { FakeTenantContext } from '../helpers/fake-azure';
import type { LogAnalyticsQuery, Rule } from '@rulebeat/core';

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
    name: 'test logs rule ' + Math.random().toString(36).slice(2),
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
  const result = await createUser({ email: 'editor@example.com', role: 'editor' });
  if ('error' in result) throw new Error(result.error);
  await setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
  mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
}

const VALID_LQ: LogAnalyticsQuery = { kql: 'SigninLogs | where ResultType != 0', timeWindowDays: 30 };

describe('POST /api/rules — Log Analytics backend guard (spec 036)', () => {
  beforeEach(async () => {
    await resetDb();
    mockAuth.mockReset();
    connectError = null;
    fakeCtx = null;
    await signInAsEditor();
  });

  it('rejects a log-analytics rule with no logsQuery at all', async () => {
    const before = (await loadRules()).length;
    const res = await POST(postRequest(baseBody({ queryBackend: 'log-analytics' })));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/needs a.*query/);
    expect((await loadRules()).length).toBe(before);
  });

  it('rejects a logsQuery with an empty/blank kql', async () => {
    const res = await POST(postRequest(baseBody({
      queryBackend: 'log-analytics',
      logsQuery: { kql: '   ', timeWindowDays: 30 },
    })));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/KQL query/);
  });

  it.each([
    ['NaN', Number.NaN],
    ['zero', 0],
    ['negative', -5],
    ['non-integer', 3.5],
    ['over the 730-day cap', 731],
  ])('rejects a logsQuery whose timeWindowDays is %s', async (_label, timeWindowDays) => {
    const res = await POST(postRequest(baseBody({
      queryBackend: 'log-analytics',
      logsQuery: { kql: VALID_LQ.kql, timeWindowDays },
    })));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/Time window/);
  });

  it('rejects a blank (whitespace-only) dimensionKeyField rather than treating it as unset', async () => {
    const res = await POST(postRequest(baseBody({
      queryBackend: 'log-analytics',
      logsQuery: { ...VALID_LQ, dimensionKeyField: '   ' },
    })));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/Dimension key field/);
  });

  it('saves a valid log-analytics rule, persisting queryBackend, logsQuery and kind:activity', async () => {
    fakeCtx = fakeTenantContext({ logsRows: [{ UserId: 'u1' }] });
    const res = await POST(postRequest(baseBody({ queryBackend: 'log-analytics', logsQuery: VALID_LQ })));
    expect(res.status).toBe(201);
    const json = await res.json();
    const saved = (await loadRules()).find(r => r.id === json.id);
    expect(saved?.queryBackend).toBe('log-analytics');
    expect(saved?.logsQuery).toEqual(VALID_LQ);
    // deriveKind() maps log-analytics to 'activity' and both other backends to 'state' — unlike
    // resource-graph/microsoft-graph rules, a log-analytics rule's findings never carry a resourceId
    // (see law-runner.ts's createActivityFinding() call), so kind:'activity' here is the rule
    // correctly declaring in advance the same shape its own findings will have at scan time.
    expect(saved?.kind).toBe('activity');
    expect(fakeCtx?.logsQueries).toHaveLength(1);
  });

  it('saves a valid log-analytics rule with a dimensionKeyField set', async () => {
    fakeCtx = fakeTenantContext({ logsRows: [] });
    const lq: LogAnalyticsQuery = { ...VALID_LQ, dimensionKeyField: 'UserId' };
    const res = await POST(postRequest(baseBody({ queryBackend: 'log-analytics', logsQuery: lq })));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect((await loadRules()).find(r => r.id === json.id)?.logsQuery).toEqual(lq);
  });

  it('fails open and still saves when the Log Analytics probe cannot connect to Azure at all', async () => {
    connectError = new Error('no credential configured');
    const res = await POST(postRequest(baseBody({ queryBackend: 'log-analytics', logsQuery: VALID_LQ })));
    expect(res.status).toBe(201);
  });

  it('fails open and still saves when the Log Analytics probe query itself throws', async () => {
    fakeCtx = fakeTenantContext({ logsFailWith: new Error('Bad request: syntax error') });
    const res = await POST(postRequest(baseBody({ queryBackend: 'log-analytics', logsQuery: VALID_LQ })));
    expect(res.status).toBe(201);
  });

  it('fails open and still saves when no workspace is configured yet', async () => {
    fakeCtx = fakeTenantContext({}); // logsRows unset -> probe hits LogAnalyticsNotConfiguredError
    const res = await POST(postRequest(baseBody({ queryBackend: 'log-analytics', logsQuery: VALID_LQ })));
    expect(res.status).toBe(201);
  });
});

describe('PUT /api/rules/[id] — Log Analytics backend guard (spec 036)', () => {
  let customRuleId: string;

  beforeEach(async () => {
    await resetDb();
    mockAuth.mockReset();
    connectError = null;
    fakeCtx = null;
    await signInAsEditor();

    customRuleId = globalThis.crypto.randomUUID();
    await saveRules([
      ...await loadRules(),
      {
        id: customRuleId,
        name: 'existing custom logs rule',
        description: 'a test rule',
        category: 'identity',
        severity: 'medium',
        enabled: true,
        type: 'custom',
        queryBackend: 'log-analytics',
        scope: { level: 'resource' },
        resourceTypes: [],
        conditions: [],
        logsQuery: VALID_LQ,
      },
    ]);
  });

  it('rejects an edit that clears logsQuery on an existing log-analytics custom rule', async () => {
    const res = await PUT(
      putRequest({ ...baseBody(), id: customRuleId, logsQuery: undefined }),
      { params: Promise.resolve({ id: customRuleId }) },
    );
    expect(res.status).toBe(400);
  });

  it('rejects an edit whose new logsQuery has an invalid time window, leaving the stored rule untouched', async () => {
    const res = await PUT(
      putRequest({ ...baseBody(), id: customRuleId, logsQuery: { ...VALID_LQ, timeWindowDays: 0 } }),
      { params: Promise.resolve({ id: customRuleId }) },
    );
    expect(res.status).toBe(400);
    expect((await loadRules()).find(r => r.id === customRuleId)?.logsQuery).toEqual(VALID_LQ);
  });

  it('saves an edit whose new logsQuery is valid', async () => {
    fakeCtx = fakeTenantContext({ logsRows: [] });
    const newLq: LogAnalyticsQuery = { kql: 'AuditLogs | where Result == "failure"', timeWindowDays: 14 };
    const res = await PUT(
      putRequest({ ...baseBody(), id: customRuleId, logsQuery: newLq }),
      { params: Promise.resolve({ id: customRuleId }) },
    );
    expect(res.status).toBe(200);
    expect((await loadRules()).find(r => r.id === customRuleId)?.logsQuery).toEqual(newLq);
  });
});
