import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { CompareUnavailable, openCompareExport } from '@/lib/db/scan-compare';
import { COMPARE_ERRORS } from '@/lib/compare-response';
import { COMPARE_PARAMS, compareQueryFromParams, parseCompareIds } from '@/lib/compare-query';
import { streamSnapshotExport } from '@/lib/snapshot-export';
import { parseExportFormat } from '@/lib/view-request';

const CONTENT_TYPES = { csv: 'text/csv; charset=utf-8', json: 'application/json; charset=utf-8' } as const;

/** The records on one side of a compare of two past scans, as CSV or JSON, streamed (ADR 0008). The query
 *  string is the compare route's own; the page in it is ignored, since a file holds the whole side. */
export async function GET(req: Request) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  const search = new URL(req.url).searchParams;
  const format = parseExportFormat(search.get('format'));
  if (!format.ok) return Response.json({ error: format.error }, { status: 400 });
  const ids = parseCompareIds(search.get(COMPARE_PARAMS.ids));
  if (!ids) return NextResponse.json(COMPARE_ERRORS['bad-request'].body, { status: COMPARE_ERRORS['bad-request'].status });
  const { side } = compareQueryFromParams(search);

  try {
    const body = await streamSnapshotExport(openCompareExport(ids[0], ids[1], side), format.value);
    return new Response(body, {
      headers: {
        'Content-Type': CONTENT_TYPES[format.value],
        'Content-Disposition': `attachment; filename="compare-${side}.${format.value}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    if (err instanceof CompareUnavailable) return NextResponse.json(COMPARE_ERRORS[err.code].body, { status: COMPARE_ERRORS[err.code].status });
    return serverError('Could not export the findings of this compare', err);
  }
}
