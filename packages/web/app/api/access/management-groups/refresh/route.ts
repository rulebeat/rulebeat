import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { writeAudit } from '@/lib/db/audit';
import { refreshManagementGroupHierarchy } from '@/lib/management-group-hierarchy';
import { hierarchyResponse } from '@/lib/management-group-response';

export const dynamic = 'force-dynamic';

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * Reads the management group tree from Azure now and replaces RuleBeat's copy of it. The answer carries
 * the tree and status as the GET does, so the page shows what is stored after the attempt. A failed read
 * answers 502 (503 when Azure is not connected) with the stable message, and the tree it keeps is the last
 * one that loaded. The audit entry holds a summary only: no group, subscription or tenant id.
 */
export async function POST() {
  const actor = await requireRole('users:manage');
  if (actor instanceof NextResponse) return actor;

  try {
    const result = await refreshManagementGroupHierarchy();
    await writeAudit({
      actor,
      action: 'management_groups.refresh',
      entityType: 'management_group_hierarchy',
      summary: result.ok
        ? `${actor.email} refreshed the management group tree (${count(result.groups, 'group')}, ${count(result.subscriptions, 'subscription')})`
        : `${actor.email} tried to refresh the management group tree and it failed`,
    });
    const body = await hierarchyResponse();
    if (result.ok) return NextResponse.json(body);
    const notConnected = result.error.code === 'azure_not_configured';
    return NextResponse.json(
      { ...body, error: result.error.message, code: result.error.code },
      { status: notConnected ? 503 : 502 },
    );
  } catch (err) {
    return serverError('Could not refresh the management group tree', err);
  }
}
