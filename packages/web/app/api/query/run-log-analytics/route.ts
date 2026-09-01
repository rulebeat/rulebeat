import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { azureError, safeErrorMessage } from '@/lib/api-error';
import { writeAudit } from '@/lib/db/audit';
import { touchSavedQueryLastRun } from '@/lib/db/saved-queries';
import { recordQueryRun } from '@/lib/db/query-runs';
import { LogAnalyticsNotConfiguredError, LogAnalyticsTruncatedError, type LogAnalyticsQuery, type TenantContext } from '@rulebeat/core';
import { createTenantContext } from '@/lib/azure-credential';

// This route's own display cap on the JSON payload — distinct from Azure's own truncation signal.
const RESPONSE_ROW_CAP = 500;

export async function POST(req: Request) {
  const actor = await requireRole('rules:validate');
  if (actor instanceof NextResponse) return actor;

  const parsed = await parseJsonBody<{ logsQuery?: LogAnalyticsQuery; savedQueryId?: string }>(req);
  if (parsed instanceof NextResponse) return parsed;
  const { logsQuery, savedQueryId } = parsed;
  // Deliberately not validateLogAnalyticsQueryShape() — that also requires timeWindowDays, which
  // this page never collects (spec 037): timeWindowDays is display/validation metadata that only
  // matters once a query becomes a rule, asked for at the existing "Save as rule" step instead.
  if (!logsQuery?.kql?.trim()) return NextResponse.json({ error: 'logsQuery.kql is required' }, { status: 400 });

  let ctx: TenantContext;
  try {
    ctx = await createTenantContext();
  } catch (err) {
    return azureError('Could not connect to Azure to run this query', err);
  }

  try {
    const rows = await ctx.queryLogs<Record<string, unknown>>(logsQuery.kql);
    const capped = rows.length > RESPONSE_ROW_CAP;
    const sample = capped ? rows.slice(0, RESPONSE_ROW_CAP) : rows;

    if (savedQueryId) await touchSavedQueryLastRun(savedQueryId, actor.id);
    await writeAudit({
      actor,
      action: 'query.run',
      entityType: 'query',
      entityId: savedQueryId,
      summary: capped
        ? `Ran a log-analytics query (${RESPONSE_ROW_CAP} of ${rows.length} rows shown)`
        : `Ran a log-analytics query (${rows.length} rows)`,
    });
    await recordQueryRun({
      queryBackend: 'log-analytics', logsQuery, savedQueryId, ownerId: actor.id,
      count: rows.length, capped, truncated: false,
    });

    return NextResponse.json({ count: rows.length, capped, truncated: false, rows: sample });
  } catch (err) {
    if (err instanceof LogAnalyticsTruncatedError) {
      if (savedQueryId) await touchSavedQueryLastRun(savedQueryId, actor.id);
      await writeAudit({
        actor,
        action: 'query.run',
        entityType: 'query',
        entityId: savedQueryId,
        summary: `Ran a log-analytics query (truncated after ${err.rowsSeen} rows)`,
      });
      await recordQueryRun({
        queryBackend: 'log-analytics', logsQuery, savedQueryId, ownerId: actor.id,
        count: err.rowsSeen, capped: false, truncated: true,
      });
      return NextResponse.json({ count: err.rowsSeen, capped: false, truncated: true, rows: [] });
    }
    if (err instanceof LogAnalyticsNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json({ error: safeErrorMessage('Running Log Analytics query', err) }, { status: 502 });
  }
}
