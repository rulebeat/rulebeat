import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { setRulesEnabled } from '@/lib/rules';
import { writeAudit } from '@/lib/db/audit';

/**
 * Flips `enabled` for many rules in one request — onboarding step 3's "All / High + critical only /
 * None" pickers can touch all 156 rules in one submit. One audit row covers the whole batch (counts
 * only); 143 ids in a details blob would bury every other entry in the log.
 */
export async function PATCH(req: Request) {
  const actor = await requireRole('rules:write');
  if (actor instanceof NextResponse) return actor;

  const body = await parseJsonBody<{ enable?: string[]; disable?: string[] }>(req);
  if (body instanceof NextResponse) return body;
  const enableIds = body.enable ?? [];
  const disableIds = body.disable ?? [];

  const enabledResult = setRulesEnabled(enableIds, true);
  const disabledResult = setRulesEnabled(disableIds, false);

  const updated = enabledResult.updatedIds.length + disabledResult.updatedIds.length;
  const notFound = [...enabledResult.notFoundIds, ...disabledResult.notFoundIds];

  if (updated > 0) {
    writeAudit({
      actor,
      action: 'rule.bulk_update',
      entityType: 'rule',
      summary: `Enabled ${enabledResult.updatedIds.length} rules and disabled ${disabledResult.updatedIds.length} rules`,
      details: { enabledCount: enabledResult.updatedIds.length, disabledCount: disabledResult.updatedIds.length },
    });
  }

  return NextResponse.json({ updated, notFound });
}
