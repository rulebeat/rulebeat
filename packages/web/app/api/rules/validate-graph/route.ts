import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { azureError, safeErrorMessage } from '@/lib/api-error';
import { buildGraphPath, extractAzureErrorMessage, GraphTruncatedError, type GraphQuery, type TenantContext } from '@rulebeat/core';
import { createTenantContext } from '@/lib/azure-credential';
import { validateGraphQueryShape } from '@/lib/graph-rule-validation';

type GraphRow = { id?: string; displayName?: string };

/**
 * Same 400-only gate as validate-kql's extractAzureError, adapted to how a Graph failure actually
 * surfaces here: graphGetAll() (packages/core/src/auth/index.ts) throws a plain Error whose message
 * is `Graph API {status}: {body}` — there is no nested SDK error object to unwrap for this backend,
 * so the status is read back out of the message instead. Only a 400 (a malformed $filter) is
 * something the person validating a query can act on; anything else risks naming the tenant/identity
 * and goes through `azureError`/`safeErrorMessage` instead.
 */
function extractGraphQueryError(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const match = /^Graph API (\d+):/.exec(err.message);
  if (!match || match[1] !== '400') return null;
  return extractAzureErrorMessage(err);
}

export async function POST(req: Request) {
  const actor = await requireRole('rules:validate');
  if (actor instanceof NextResponse) return actor;

  const parsed = await parseJsonBody<{ graphQuery?: GraphQuery }>(req);
  if (parsed instanceof NextResponse) return parsed;
  const { graphQuery } = parsed;
  if (!graphQuery) return NextResponse.json({ error: 'graphQuery is required' }, { status: 400 });

  const shapeError = validateGraphQueryShape(graphQuery);
  if (shapeError) return NextResponse.json({ error: shapeError }, { status: 400 });

  let ctx: TenantContext;
  try {
    ctx = await createTenantContext();
  } catch (err) {
    // Deliberately not `extractGraphQueryError`: a credential failure describes which identity
    // sources were tried and against which tenant, which the person validating a query cannot act
    // on anyway. `azureError` still lets the one actionable case through — Azure isn't connected yet.
    return azureError('Could not connect to Azure to validate this query', err);
  }

  try {
    const rows = await ctx.graphGet<GraphRow>(buildGraphPath(graphQuery));
    return NextResponse.json({
      count: rows.length,
      truncated: false,
      samples: rows.slice(0, 5).map(r => ({
        id: String(r.id ?? ''),
        displayName: String(r.displayName ?? '(unnamed)'),
      })),
    });
  } catch (err) {
    // A capped result is real data, not a failure — same "capped, not failed" distinction
    // runGraphRules() draws for a scan, just with no partial rows to preview here.
    if (err instanceof GraphTruncatedError) {
      return NextResponse.json({ count: err.rowsSeen, truncated: true, samples: [] });
    }
    const queryError = extractGraphQueryError(err);
    if (queryError) return NextResponse.json({ error: queryError }, { status: 400 });
    return NextResponse.json({ error: safeErrorMessage('Validating Graph query', err) }, { status: 502 });
  }
}
