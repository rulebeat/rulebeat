import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { azureError, safeErrorMessage } from '@/lib/api-error';
import { writeAudit } from '@/lib/db/audit';
import { touchSavedQueryLastRun } from '@/lib/db/saved-queries';
import { recordQueryRun } from '@/lib/db/query-runs';
import { buildGraphPath, extractAzureErrorMessage, GraphTruncatedError, type GraphQuery, type TenantContext } from '@rulebeat/core';
import { createTenantContext } from '@/lib/azure-credential';
import { validateGraphQueryShape } from '@/lib/graph-rule-validation';

// This route's own display cap on the JSON payload — distinct from Azure's own truncation signal.
const RESPONSE_ROW_CAP = 500;

/**
 * Same 400-only gate as validate-graph's twin helper: graphGetAll() throws a plain Error whose
 * message is `Graph API {status}: {body}` — only a 400 (a malformed $filter) is safe and actionable
 * to show verbatim; anything else risks naming the tenant/identity.
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

  const parsed = await parseJsonBody<{ graphQuery?: GraphQuery; savedQueryId?: string }>(req);
  if (parsed instanceof NextResponse) return parsed;
  const { graphQuery, savedQueryId } = parsed;
  if (!graphQuery) return NextResponse.json({ error: 'graphQuery is required' }, { status: 400 });

  // The 7-path resource allowlist — this IS the security boundary for a Directory query, checked
  // unconditionally before anything touches Azure. Live query is not a way to reach a Graph path
  // rule authoring's own validate-graph route doesn't already allow.
  const shapeError = validateGraphQueryShape(graphQuery);
  if (shapeError) return NextResponse.json({ error: shapeError }, { status: 400 });

  let ctx: TenantContext;
  try {
    ctx = await createTenantContext();
  } catch (err) {
    return azureError('Could not connect to Azure to run this query', err);
  }

  try {
    const rows = await ctx.graphGet<Record<string, unknown>>(buildGraphPath(graphQuery));
    const capped = rows.length > RESPONSE_ROW_CAP;
    const sample = capped ? rows.slice(0, RESPONSE_ROW_CAP) : rows;

    if (savedQueryId) touchSavedQueryLastRun(savedQueryId, actor.id);
    writeAudit({
      actor,
      action: 'query.run',
      entityType: 'query',
      entityId: savedQueryId,
      summary: capped
        ? `Ran a microsoft-graph query (${RESPONSE_ROW_CAP} of ${rows.length} rows shown)`
        : `Ran a microsoft-graph query (${rows.length} rows)`,
    });
    recordQueryRun({
      queryBackend: 'microsoft-graph', graphQuery, savedQueryId, ownerId: actor.id,
      count: rows.length, capped, truncated: false,
    });

    return NextResponse.json({ count: rows.length, capped, truncated: false, rows: sample });
  } catch (err) {
    if (err instanceof GraphTruncatedError) {
      if (savedQueryId) touchSavedQueryLastRun(savedQueryId, actor.id);
      writeAudit({
        actor,
        action: 'query.run',
        entityType: 'query',
        entityId: savedQueryId,
        summary: `Ran a microsoft-graph query (truncated after ${err.rowsSeen} rows)`,
      });
      recordQueryRun({
        queryBackend: 'microsoft-graph', graphQuery, savedQueryId, ownerId: actor.id,
        count: err.rowsSeen, capped: false, truncated: true,
      });
      return NextResponse.json({ count: err.rowsSeen, capped: false, truncated: true, rows: [] });
    }
    const queryError = extractGraphQueryError(err);
    if (queryError) return NextResponse.json({ error: queryError }, { status: 400 });
    return NextResponse.json({ error: safeErrorMessage('Running Graph query', err) }, { status: 502 });
  }
}
