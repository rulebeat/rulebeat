import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { azureError, safeErrorMessage } from '@/lib/api-error';
import { LogAnalyticsNotConfiguredError, LogAnalyticsTruncatedError, type LogAnalyticsQuery, type TenantContext } from '@rulebeat/core';
import { createTenantContext } from '@/lib/azure-credential';
import { validateLogAnalyticsQueryShape } from '@/lib/log-analytics-rule-validation';

export async function POST(req: Request) {
  const actor = await requireRole('rules:validate');
  if (actor instanceof NextResponse) return actor;

  const parsed = await parseJsonBody<{ logsQuery?: LogAnalyticsQuery }>(req);
  if (parsed instanceof NextResponse) return parsed;
  const { logsQuery } = parsed;
  if (!logsQuery) return NextResponse.json({ error: 'logsQuery is required' }, { status: 400 });

  const shapeError = validateLogAnalyticsQueryShape(logsQuery);
  if (shapeError) return NextResponse.json({ error: shapeError }, { status: 400 });

  let ctx: TenantContext;
  try {
    ctx = await createTenantContext();
  } catch (err) {
    // Deliberately not surfaced verbatim: a credential failure describes which identity sources
    // were tried and against which tenant, which the person validating a query cannot act on anyway.
    return azureError('Could not connect to Azure to validate this query', err);
  }

  try {
    const rows = await ctx.queryLogs<Record<string, unknown>>(logsQuery.kql);
    return NextResponse.json({
      count: rows.length,
      truncated: false,
      samples: rows.slice(0, 5),
    });
  } catch (err) {
    // A capped result is real data, not a failure — same "capped, not failed" distinction
    // runLawRules() draws for a scan, just with no partial rows to preview here.
    if (err instanceof LogAnalyticsTruncatedError) {
      return NextResponse.json({ count: err.rowsSeen, truncated: true, samples: [] });
    }
    // Distinct, actionable, and reliably detectable (its own error class, not a string match) —
    // unlike the fallback below, telling the person "go configure a workspace" is safe to do here.
    if (err instanceof LogAnalyticsNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    // A bad KQL string has no purpose-built error class the way truncation/not-configured do —
    // queryLogAnalyticsWorkspace() wraps it (and any real connectivity failure) through the same
    // generic extractAzureErrorMessage() unwrap, so the two aren't reliably distinguishable here
    // (spec 036 risk #1). Falls back to the same safe generic path validate-graph's own catch-all
    // uses rather than guessing: a rule author sees "couldn't validate" rather than a wrong message.
    return NextResponse.json({ error: safeErrorMessage('Validating Log Analytics query', err) }, { status: 502 });
  }
}
