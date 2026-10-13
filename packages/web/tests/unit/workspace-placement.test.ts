/**
 * #271: the startup step that gives a stored Logs finding the subscription of its workspace. Driven with
 * an injected context (no Azure), over findings and Run History records a scan left unplaceable. It asks
 * Azure only when a Logs finding needs placing, and it never throws.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { many, run as execRun } from '@/lib/db/exec';
import { findings as findingsTable, rules as rulesTable, scanFindings } from '@/lib/db/tables';
import { getCategory } from '@/lib/db/categories';
import { runCategoryScan } from '@/lib/scan-runner';
import { placeWorkspaceFindings } from '@/lib/workspace-placement';
import { resetDb } from '../helpers/db';
import { fakeTenantContext, TEST_SUB_A, TEST_SUB_B } from '../helpers/fake-azure';
import { EVERYTHING_ACCESS } from '../helpers/access';

const LOGS_RULE = 'test-workspace-step-logs-rule';
const WORKSPACE_CUSTOMER_ID = '99999999-9999-9999-9999-999999999999';
const T1 = new Date('2026-03-01T00:00:00.000Z');

const workspaceRow = () => ({
  id: `/subscriptions/${TEST_SUB_B}/resourceGroups/rg-logs/providers/Microsoft.OperationalInsights/workspaces/law-1`,
  subscriptionId: TEST_SUB_B, resourceGroup: 'rg-logs', customerId: WORKSPACE_CUSTOMER_ID,
});

/** What the step is handed: a context whose Resource Graph answers the workspace lookup with `lookup`. */
const lookupContext = (lookup: () => Record<string, unknown>[]) =>
  fakeTenantContext({ subscriptionIds: [TEST_SUB_A], logAnalyticsWorkspaceId: WORKSPACE_CUSTOMER_ID, rows: () => lookup() });

/** A scan that left one Logs finding, placed nowhere because its workspace was not found. */
async function scanLeavingUnplaceableFinding(): Promise<string> {
  await execRun(db.delete(rulesTable).where(eq(rulesTable.id, LOGS_RULE)));
  await execRun(db.insert(rulesTable).values({
    id: LOGS_RULE, name: LOGS_RULE, description: 'test rule', category: 'identity', severity: 'medium', enabled: true,
    scope: JSON.stringify({ level: 'subscription' }), resourceTypes: JSON.stringify([]), conditions: JSON.stringify([]),
    queryBackend: 'log-analytics', type: 'custom',
    logsQuery: JSON.stringify({ kql: 'SigninLogs | where ResultType != 0', timeWindowDays: 30, dimensionKeyField: 'UserId' }),
  }));
  const ctx = fakeTenantContext({ logAnalyticsWorkspaceId: WORKSPACE_CUSTOMER_ID, rows: () => [], logsRows: [{ UserId: 'u1' }] });
  const { summary } = await runCategoryScan((await getCategory('identity'))!, { access: EVERYTHING_ACCESS, ctx, ruleIds: [LOGS_RULE], now: T1 });
  return summary.id!;
}

const stored = () => many(db.select().from(findingsTable).where(eq(findingsTable.ruleId, LOGS_RULE)));
const records = () => many(db.select().from(scanFindings).where(eq(scanFindings.ruleId, LOGS_RULE)));

describe('placing stored Logs findings at their workspace on startup (#271)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('moves a finding and its Run History records to the workspace once it resolves, changing nothing else about them', async () => {
    await scanLeavingUnplaceableFinding();
    const [before] = await stored();
    expect(before).toMatchObject({ placement: 'unplaceable', subscriptionId: '' });

    expect(await placeWorkspaceFindings({ ctx: lookupContext(() => [workspaceRow()]) })).toBe('placed');

    const [after] = await stored();
    expect(after).toMatchObject({ placement: 'workspace', subscriptionId: TEST_SUB_B, resourceGroup: 'rg-logs', managementGroupId: null });
    expect({ ...after, placement: before!.placement, subscriptionId: before!.subscriptionId, resourceGroup: before!.resourceGroup }).toEqual(before);
    expect(await records()).toEqual([expect.objectContaining({ placement: 'workspace', subscriptionId: TEST_SUB_B, resourceGroup: 'rg-logs' })]);
  });

  it('leaves the findings as they are when the workspace is not found, and asks again on the next start', async () => {
    await scanLeavingUnplaceableFinding();
    const ctx = lookupContext(() => []);

    expect(await placeWorkspaceFindings({ ctx })).toBe('unresolved');

    expect((await stored())[0]).toMatchObject({ placement: 'unplaceable', subscriptionId: '' });
    expect(ctx.queries).toHaveLength(1);
  });

  it('leaves the findings as they are, and does not throw, when the lookup throws', async () => {
    await scanLeavingUnplaceableFinding();
    const ctx = lookupContext(() => { throw new Error('Resource Graph is down'); });

    expect(await placeWorkspaceFindings({ ctx })).toBe('unresolved');

    expect((await stored())[0]).toMatchObject({ placement: 'unplaceable', subscriptionId: '' });
  });

  it('asks Azure nothing when no Logs finding needs placing', async () => {
    const ctx = lookupContext(() => [workspaceRow()]);

    expect(await placeWorkspaceFindings({ ctx })).toBe('nothing-to-place');
    expect(ctx.queries).toEqual([]);
  });

  it('asks Azure nothing on a second start, once every Logs finding is at its workspace', async () => {
    await scanLeavingUnplaceableFinding();
    await placeWorkspaceFindings({ ctx: lookupContext(() => [workspaceRow()]) });

    const ctx = lookupContext(() => [workspaceRow()]);
    expect(await placeWorkspaceFindings({ ctx })).toBe('nothing-to-place');
    expect(ctx.queries).toEqual([]);
  });

  it('does not throw, and changes nothing, when the step itself fails', async () => {
    await scanLeavingUnplaceableFinding();
    // A context with no logger makes the lookup's own error handling throw: a failure the lookup cannot absorb.
    const broken = { ...lookupContext(() => { throw new Error('Resource Graph is down'); }), log: undefined } as unknown as ReturnType<typeof lookupContext>;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(placeWorkspaceFindings({ ctx: broken })).resolves.toBe('failed');

    expect(logged).toHaveBeenCalled();
    expect((await stored())[0]).toMatchObject({ placement: 'unplaceable', subscriptionId: '' });
    logged.mockRestore();
  });
});
