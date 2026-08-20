import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { azureError, safeErrorMessage } from '@/lib/api-error';
import { extractAzureErrorMessage, type TenantContext } from '@rulebeat/core';
import { createTenantContext } from '@/lib/azure-credential';
import { checkRowsHaveIdentity } from '@/lib/rule-identity-check';

type Row = { id: string; name: string; type: string; resourceGroup: string; subscriptionId: string };

/**
 * Only a 400 from Resource Graph is a malformed-query error the user can act on. A 403 or 429
 * carries the same details[]/parsedBody.error shape but its message names the subscription or
 * tenant that was denied or throttled — safe for the server log, not for the browser. Anything
 * that isn't a plain 400 goes through `azureError`/`safeErrorMessage` instead of being extracted.
 * The nested-shape unwrapping itself is the shared core helper — this only adds the 400-only gate
 * that decides what's safe to show the browser.
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

  const parsed = await parseJsonBody<{ kql?: string }>(req);
  if (parsed instanceof NextResponse) return parsed;
  const { kql } = parsed;
  if (!kql?.trim()) return NextResponse.json({ error: 'kql is required' }, { status: 400 });

  let ctx: TenantContext;
  try {
    ctx = await createTenantContext();
  } catch (err) {
    // Deliberately not `extractAzureError`: a credential failure describes which identity sources
    // were tried and against which tenant, which the person validating a query cannot act on anyway.
    // `azureError` still lets the one actionable case through — Azure isn't connected yet.
    return azureError('Could not connect to Azure to validate this query', err);
  }

  // Append | take 5 unless the query already limits rows.
  // KQL `top` requires a `by` clause — use `take` (alias: limit) for unconditional row cap.
  const limitedKql = /\|\s*(take|limit|top)\s+\d+/i.test(kql)
    ? kql
    : `${kql.trim()}\n| take 5`;

  try {
    const rows = await ctx.queryARG<Row>(limitedKql);
    const identity = checkRowsHaveIdentity(rows);
    if (!identity.valid) {
      return NextResponse.json({
        error: `${identity.invalidCount} of ${rows.length} sampled row(s) have no resource id — project id explicitly in the query`,
      }, { status: 400 });
    }
    return NextResponse.json({
      count: rows.length,
      samples: rows.map(r => ({
        name: r.name ?? '(unnamed)',
        type: r.type ?? '',
        resourceGroup: r.resourceGroup ?? '',
        subscriptionId: r.subscriptionId ?? '',
      })),
    });
  } catch (err) {
    const queryError = extractAzureError(err);
    if (queryError) return NextResponse.json({ error: queryError }, { status: 400 });
    return NextResponse.json({ error: safeErrorMessage('Validating KQL query', err) }, { status: 502 });
  }
}
