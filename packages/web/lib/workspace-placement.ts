import { and, eq, ne } from 'drizzle-orm';
import { resolveWorkspacePlacement, type TenantContext } from '@rulebeat/core';
import { db } from './db/client';
import { findings as findingsTable, scanFindings as scanFindingsTable } from './db/tables';
import { inTransaction, one, run } from './db/exec';
import { resolveLogAnalyticsWorkspaceId } from './log-analytics-workspace';
import { createScanContext } from './scan-context';
import { SYSTEM_ACCESS } from './system-access';

/**
 * Moves the stored Logs findings to the workspace they sit at (#271).
 *
 * The upgrade (lib/db/finding-placement.ts) cannot call Azure, so it leaves every stored `activity`
 * finding, and every Run History record of one, `unplaceable` with no subscription. This step, run at
 * startup, asks Resource Graph where the configured workspace is (`resolveWorkspacePlacement()`, the
 * same lookup a scan makes) and gives those findings its subscription and resource group. Nothing else
 * about a finding changes: not its fingerprint, age, events, rows or suppressions.
 *
 * It asks Azure only when a Logs finding needs placing, and a second start finds none and asks nothing.
 * A workspace that cannot be resolved leaves the findings as they are for the next start, and the next
 * scan that resolves it places them anyway. It never throws: it runs from `instrumentation.ts`, and
 * nothing here is worth stopping the app booting.
 */
export type WorkspacePlacementResult = 'nothing-to-place' | 'placed' | 'unresolved' | 'failed';

const needsPlacing = (t: typeof findingsTable | typeof scanFindingsTable) => and(eq(t.kind, 'activity'), ne(t.placement, 'workspace'));

async function anyToPlace(): Promise<boolean> {
  for (const t of [findingsTable, scanFindingsTable]) {
    if (await one(db.select({ kind: t.kind }).from(t).where(needsPlacing(t)).limit(1))) return true;
  }
  return false;
}

/** `ctx` is for a caller that already holds one (a test); without it the step builds the scan context, and only when a workspace is configured. */
export async function placeWorkspaceFindings(opts: { ctx?: TenantContext } = {}): Promise<WorkspacePlacementResult> {
  try {
    if (!(await anyToPlace())) return 'nothing-to-place';

    let ctx = opts.ctx;
    if (!ctx) {
      // No workspace configured is nothing to look up, and no reason to open an Azure connection.
      if (!(await resolveLogAnalyticsWorkspaceId())) return 'unresolved';
      ctx = await createScanContext(SYSTEM_ACCESS);
    }
    const workspace = await resolveWorkspacePlacement(ctx);
    if (!workspace) return 'unresolved';

    await inTransaction(async (tx) => {
      for (const t of [findingsTable, scanFindingsTable]) {
        await run(tx.update(t).set({
          placement: 'workspace',
          subscriptionId: workspace.subscriptionId,
          resourceGroup: workspace.resourceGroup ?? null,
          managementGroupId: null,
        }).where(needsPlacing(t)));
      }
    });
    return 'placed';
  } catch (err) {
    console.error('[startup] could not place Log Analytics findings at their workspace:', err);
    return 'failed';
  }
}
