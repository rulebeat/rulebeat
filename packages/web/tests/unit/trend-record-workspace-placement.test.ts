/**
 * Workspace placement records its cells (ADR 0012): the startup step that moves the stored Logs findings to their
 * workspace recounts the rules of the findings it moved, in the same transaction and after the move, and a record
 * write that fails leaves the findings where they were for the next start. The recount is observed at the trend-record
 * module's `recountTrend()`, the one function every posture input calls; everything else is the real step and database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { many, run } from '@/lib/db/exec';
import { findings as findingsTable } from '@/lib/db/tables';
import type { DbHandle } from '@/lib/db/exec';
import { resetDb } from '../helpers/db';
import { fakeTenantContext, TEST_SUB_A, TEST_SUB_B } from '../helpers/fake-azure';

const LOGS_RULE = 'test-workspace-record-logs-rule';
const WORKSPACE_CUSTOMER_ID = '99999999-9999-9999-9999-999999999999';
const NOW = new Date('2026-03-10T09:00:00.000Z');

const record = vi.hoisted(() => ({ fail: false, calls: [] as { ruleIds: readonly string[] | undefined; now: Date | undefined; placements: string[] }[] }));
vi.mock('@/lib/db/trend-record', async () => {
  const actual = await vi.importActual<typeof import('@/lib/db/trend-record')>('@/lib/db/trend-record');
  return {
    ...actual,
    recountTrend: async (tx: DbHandle, opts?: Parameters<typeof actual.recountTrend>[1]) => {
      // Imported when called: the database client imports this module, so importing it here would wait on itself.
      const { findings } = await import('@/lib/db/tables');
      const { many } = await import('@/lib/db/exec');
      const placements = (await many(tx.select({ placement: findings.placement }).from(findings))).map(r => r.placement);
      record.calls.push({ ruleIds: opts?.ruleIds, now: opts?.now, placements });
      if (record.fail) throw new Error('record write failed');
      return actual.recountTrend(tx, opts);
    },
  };
});

const { placeWorkspaceFindings } = await import('@/lib/workspace-placement');

const lookup = () => fakeTenantContext({
  subscriptionIds: [TEST_SUB_A], logAnalyticsWorkspaceId: WORKSPACE_CUSTOMER_ID,
  rows: () => [{
    id: `/subscriptions/${TEST_SUB_B}/resourceGroups/rg-logs/providers/Microsoft.OperationalInsights/workspaces/law-1`,
    subscriptionId: TEST_SUB_B, resourceGroup: 'rg-logs', customerId: WORKSPACE_CUSTOMER_ID,
  }],
});

const insertLogsFinding = (fingerprint: string) => run(db.insert(findingsTable).values({
  fingerprint, ruleId: LOGS_RULE, category: 'identity', severity: 'medium', kind: 'activity', subscriptionId: '', placement: 'unplaceable',
  title: 't', status: 'active', firstSeenAt: '2026-03-01T00:00:00.000Z', lastSeenAt: '2026-03-01T00:00:00.000Z',
}));
const placements = async () => (await many(db.select({ placement: findingsTable.placement }).from(findingsTable).where(eq(findingsTable.ruleId, LOGS_RULE)))).map(r => r.placement);

beforeEach(async () => {
  await resetDb();
  record.fail = false;
  record.calls.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('placing stored Logs findings at their workspace', () => {
  it('recounts the rules of the findings it moved, after the move and dated by the clock', async () => {
    await insertLogsFinding('fp-1');
    await insertLogsFinding('fp-2');

    expect(await placeWorkspaceFindings({ ctx: lookup(), now: NOW })).toBe('placed');

    expect(record.calls).toEqual([{ ruleIds: [LOGS_RULE], now: NOW, placements: ['workspace', 'workspace'] }]);
  });

  it('records nothing when no Logs finding needs placing', async () => {
    expect(await placeWorkspaceFindings({ ctx: lookup(), now: NOW })).toBe('nothing-to-place');

    expect(record.calls).toEqual([]);
  });

  it('leaves the findings unplaced for the next start when the record cannot be written', async () => {
    await insertLogsFinding('fp-1');
    record.fail = true;

    expect(await placeWorkspaceFindings({ ctx: lookup(), now: NOW })).toBe('failed');

    expect(await placements()).toEqual(['unplaceable']);
  });
});
