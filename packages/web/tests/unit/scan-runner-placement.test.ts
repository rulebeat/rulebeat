/**
 * #271: every finding records where it sits. One runCategoryScan() over the fake Azure context with a
 * Resource Graph rule, a Microsoft Graph rule and a Log Analytics rule in one category, then the stored
 * placement read back from `findings` and from `scan_findings`. Before this a Graph finding and a Logs
 * finding both carried the first subscription the credential listed.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { many, run as execRun } from '@/lib/db/exec';
import { findings as findingsTable, rules as rulesTable, scanFindings } from '@/lib/db/tables';
import { listFindings } from '@/lib/db/findings';
import { getCategory } from '@/lib/db/categories';
import { runCategoryScan } from '@/lib/scan-runner';
import { resetDb } from '../helpers/db';
import { fakeTenantContext, argRow, TEST_SUB_A, TEST_SUB_B } from '../helpers/fake-azure';
import { EVERYTHING_ACCESS } from '../helpers/access';

const ARG_RULE = 'test-placement-arg-rule';
const LOGS_RULE = 'test-placement-logs-rule';
const GRAPH_RULE = 'cred:app-secret-expiring';
const WORKSPACE_CUSTOMER_ID = '99999999-9999-9999-9999-999999999999';

const baseRule = {
  description: 'test rule',
  category: 'identity',
  severity: 'medium',
  enabled: true,
  scope: JSON.stringify({ level: 'subscription' }),
  resourceTypes: JSON.stringify([]),
  conditions: JSON.stringify([]),
  type: 'custom',
};

async function insertRules(): Promise<void> {
  await execRun(db.delete(rulesTable).where(eq(rulesTable.id, ARG_RULE)));
  await execRun(db.insert(rulesTable).values({
    ...baseRule, id: ARG_RULE, name: ARG_RULE, rawKql: 'resources | where type == "microsoft.compute/virtualmachines"',
  }));
  await execRun(db.delete(rulesTable).where(eq(rulesTable.id, LOGS_RULE)));
  await execRun(db.insert(rulesTable).values({
    ...baseRule, id: LOGS_RULE, name: LOGS_RULE, queryBackend: 'log-analytics',
    logsQuery: JSON.stringify({ kql: 'SigninLogs | where ResultType != 0', timeWindowDays: 30, dimensionKeyField: 'UserId' }),
  }));
}

const workspaceRow = () => ({
  id: '/subscriptions/' + TEST_SUB_B + '/resourceGroups/rg-logs/providers/Microsoft.OperationalInsights/workspaces/law-1',
  subscriptionId: TEST_SUB_B,
  resourceGroup: 'rg-logs',
  customerId: WORKSPACE_CUSTOMER_ID,
});

const isWorkspaceLookup = (kql: string) => kql.includes('microsoft.operationalinsights/workspaces');

function graphApp(): Record<string, unknown>[] {
  const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
  return [{
    id: 'app-1', displayName: 'Test App', appId: 'appid-1',
    passwordCredentials: [{ displayName: 'a secret', endDateTime: soon, keyId: 'key-1' }], keyCredentials: [],
  }];
}

/** A context whose Resource Graph answers the rule's query with a VM, and the workspace lookup with `workspace`. */
function context(workspace: Record<string, unknown>[] | Error) {
  return fakeTenantContext({
    subscriptionIds: [TEST_SUB_A],
    logAnalyticsWorkspaceId: WORKSPACE_CUSTOMER_ID,
    rows: (kql) => {
      if (!isWorkspaceLookup(kql)) return [argRow()];
      if (workspace instanceof Error) throw workspace;
      return workspace;
    },
    graphRows: graphApp(),
    logsRows: [{ UserId: 'u1' }],
  });
}

const RULES = [ARG_RULE, GRAPH_RULE, LOGS_RULE];

async function storedPlacement() {
  const live = await listFindings(EVERYTHING_ACCESS);
  const byRule = (ruleId: string) => live.find(f => f.ruleId === ruleId)!;
  return { live, arg: byRule(ARG_RULE), graph: byRule(GRAPH_RULE), logs: byRule(LOGS_RULE) };
}

async function recordsOf(scanId: string) {
  return many(db.select().from(scanFindings).where(eq(scanFindings.scanId, scanId)).orderBy(asc(scanFindings.ruleId)));
}

describe('a scan records where each finding sits (#271)', () => {
  beforeEach(async () => {
    await resetDb();
    await insertRules();
  });

  it('places a Resource Graph finding at its resource, a Graph finding in the directory and a Logs finding at its workspace', async () => {
    const category = (await getCategory('identity'))!;
    const outcome = await runCategoryScan(category, { access: EVERYTHING_ACCESS, ctx: context([workspaceRow()]), ruleIds: RULES });

    const { arg, graph, logs } = await storedPlacement();
    expect(arg).toMatchObject({ placement: 'resource', subscriptionId: TEST_SUB_A, resourceGroup: 'rg-test' });
    expect(graph).toMatchObject({ placement: 'directory', subscriptionId: '' });
    expect(graph.resourceGroup).toBeUndefined();
    expect(logs).toMatchObject({ placement: 'workspace', subscriptionId: TEST_SUB_B, resourceGroup: 'rg-logs' });

    // Run History keeps the same place for the same findings.
    const records = await recordsOf(outcome.summary.id!);
    expect(records.map(r => [r.ruleId, r.placement, r.subscriptionId, r.resourceGroup])).toEqual([
      [GRAPH_RULE, 'directory', '', null],
      [ARG_RULE, 'resource', TEST_SUB_A, 'rg-test'],
      [LOGS_RULE, 'workspace', TEST_SUB_B, 'rg-logs'],
    ]);
  });

  it('borrows no subscription for a finding that sits in none, whatever the credential lists first', async () => {
    const category = (await getCategory('identity'))!;
    await runCategoryScan(category, { access: EVERYTHING_ACCESS, ctx: context([workspaceRow()]), ruleIds: [GRAPH_RULE] });

    const rows = await many(db.select().from(findingsTable).where(eq(findingsTable.ruleId, GRAPH_RULE)));
    expect(rows.map(r => r.subscriptionId)).toEqual(['']);
  });

  it('calls a Logs finding unplaceable, with no subscription, when the workspace is not found', async () => {
    const category = (await getCategory('identity'))!;
    const ctx = context([]);
    const outcome = await runCategoryScan(category, { access: EVERYTHING_ACCESS, ctx, ruleIds: RULES });

    const { logs } = await storedPlacement();
    expect(logs).toMatchObject({ placement: 'unplaceable', subscriptionId: '' });
    expect((await recordsOf(outcome.summary.id!)).find(r => r.ruleId === LOGS_RULE)).toMatchObject({ placement: 'unplaceable', subscriptionId: '' });
    // The lookup failing does not change the rule's outcome.
    expect(outcome.summary.incompleteRules).toEqual([]);
    expect(ctx.logFields.some(f => f.operation === 'workspace-placement' && f.level === 'warn')).toBe(true);
  });

  it('calls a Logs finding unplaceable when the lookup throws, and still scans every rule', async () => {
    const category = (await getCategory('identity'))!;
    const outcome = await runCategoryScan(category, { access: EVERYTHING_ACCESS, ctx: context(new Error('Resource Graph is down')), ruleIds: RULES });

    const { arg, graph, logs } = await storedPlacement();
    expect(logs.placement).toBe('unplaceable');
    expect(arg.placement).toBe('resource');
    expect(graph.placement).toBe('directory');
    expect(outcome.summary.incompleteRules).toEqual([]);
  });

  it('moves a finding stored unplaceable to its workspace on the next scan that resolves it, keeping its fingerprint and age', async () => {
    const category = (await getCategory('identity'))!;
    await runCategoryScan(category, { access: EVERYTHING_ACCESS, ctx: context([]), ruleIds: [LOGS_RULE], now: new Date('2026-03-01T00:00:00.000Z') });
    const before = (await storedPlacement()).logs;
    expect(before.placement).toBe('unplaceable');

    await runCategoryScan(category, { access: EVERYTHING_ACCESS, ctx: context([workspaceRow()]), ruleIds: [LOGS_RULE], now: new Date('2026-03-02T00:00:00.000Z') });
    const after = (await storedPlacement()).logs;

    expect(after).toMatchObject({ placement: 'workspace', subscriptionId: TEST_SUB_B, resourceGroup: 'rg-logs' });
    expect(after.fingerprint).toBe(before.fingerprint);
    expect(after.firstSeenAt).toBe(before.firstSeenAt);
    expect(after.timesSeen).toBe(2);
  });

  it('keeps a Logs finding at its workspace through a scan whose lookup failed, and says unplaceable only of that scan', async () => {
    const category = (await getCategory('identity'))!;
    await runCategoryScan(category, { access: EVERYTHING_ACCESS, ctx: context([workspaceRow()]), ruleIds: [LOGS_RULE], now: new Date('2026-03-01T00:00:00.000Z') });
    const blip = await runCategoryScan(category, { access: EVERYTHING_ACCESS, ctx: context(new Error('Resource Graph is down')), ruleIds: [LOGS_RULE], now: new Date('2026-03-02T00:00:00.000Z') });

    expect((await storedPlacement()).logs).toMatchObject({ placement: 'workspace', subscriptionId: TEST_SUB_B, resourceGroup: 'rg-logs', timesSeen: 2 });
    expect((await recordsOf(blip.summary.id!))[0]).toMatchObject({ placement: 'unplaceable', subscriptionId: '' });
  });

  it('makes no workspace lookup in a scan that runs no Logs rule', async () => {
    const category = (await getCategory('identity'))!;
    const ctx = context([workspaceRow()]);
    await runCategoryScan(category, { access: EVERYTHING_ACCESS, ctx, ruleIds: [ARG_RULE, GRAPH_RULE] });

    expect(ctx.queries.some(q => isWorkspaceLookup(q.kql))).toBe(false);
  });
});
