import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { azureError, safeErrorMessage } from '@/lib/api-error';
import { writeAudit } from '@/lib/db/audit';
import { touchSavedQueryLastRun } from '@/lib/db/saved-queries';
import { recordQueryRun } from '@/lib/db/query-runs';
import { extractAzureErrorMessage, ResourceGraphTruncatedError, type TenantContext } from '@rulebeat/core';
import { createTenantContext } from '@/lib/azure-credential';
import type { RuleScope } from '@/lib/types';

// This route's own display cap on the JSON payload — distinct from Azure's own `resultTruncated`
// signal (see ResourceGraphTruncatedError below). The underlying client call is unchanged and pages
// to Azure's own limit before ever throwing; this route slices the full returned array down to this
// number itself and reports that as `capped`, independent of `truncated`.
const RESPONSE_ROW_CAP = 500;

/**
 * Only a 400 from Resource Graph is a malformed-query error the user can act on — same 400-only gate
 * as validate-kql/route.ts's twin helper. Anything else goes through azureError/safeErrorMessage.
 */
function extractAzureError(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const e = err as unknown as Record<string, unknown>;
  const statusCode = (e['statusCode'] ?? (e['response'] as Record<string, unknown> | undefined)?.['status']) as unknown;
  if (statusCode !== 400) return null;
  return extractAzureErrorMessage(err);
}

export async function POST(req: Request) {
  const actor = await requireRole('rules:validate');
  if (actor instanceof NextResponse) return actor;

  const parsed = await parseJsonBody<{ kql?: string; scope?: RuleScope; savedQueryId?: string }>(req);
  if (parsed instanceof NextResponse) return parsed;
  const { kql, scope, savedQueryId } = parsed;
  if (!kql?.trim()) return NextResponse.json({ error: 'kql is required' }, { status: 400 });

  let ctx: TenantContext;
  try {
    ctx = await createTenantContext();
  } catch (err) {
    return azureError('Could not connect to Azure to run this query', err);
  }

  try {
    const rows = await ctx.queryARG<Record<string, unknown>>(kql, scope);
    const capped = rows.length > RESPONSE_ROW_CAP;
    const sample = capped ? rows.slice(0, RESPONSE_ROW_CAP) : rows;

    if (savedQueryId) touchSavedQueryLastRun(savedQueryId, actor.id);
    writeAudit({
      actor,
      action: 'query.run',
      entityType: 'query',
      entityId: savedQueryId,
      summary: capped
        ? `Ran a resource-graph query (${RESPONSE_ROW_CAP} of ${rows.length} rows shown)`
        : `Ran a resource-graph query (${rows.length} rows)`,
    });
    recordQueryRun({
      queryBackend: 'resource-graph', scope, rawKql: kql, savedQueryId, ownerId: actor.id,
      count: rows.length, capped, truncated: false,
    });

    return NextResponse.json({ count: rows.length, capped, truncated: false, rows: sample });
  } catch (err) {
    if (err instanceof ResourceGraphTruncatedError) {
      if (savedQueryId) touchSavedQueryLastRun(savedQueryId, actor.id);
      writeAudit({
        actor,
        action: 'query.run',
        entityType: 'query',
        entityId: savedQueryId,
        summary: `Ran a resource-graph query (truncated after ${err.rowsSeen} rows)`,
      });
      recordQueryRun({
        queryBackend: 'resource-graph', scope, rawKql: kql, savedQueryId, ownerId: actor.id,
        count: err.rowsSeen, capped: false, truncated: true,
      });
      return NextResponse.json({ count: err.rowsSeen, capped: false, truncated: true, rows: [] });
    }
    const queryError = extractAzureError(err);
    if (queryError) return NextResponse.json({ error: queryError }, { status: 400 });
    return NextResponse.json({ error: safeErrorMessage('Running resource-graph query', err) }, { status: 502 });
  }
}
