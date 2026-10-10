import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { openSnapshotExport, SnapshotUnavailable } from '@/lib/db/scan-snapshots';
import { streamSnapshotExport } from '@/lib/snapshot-export';
import { SNAPSHOT_ERRORS } from '@/lib/snapshot-response';
import { snapshotQueryFromParams } from '@/lib/snapshot-query';
import { parseExportFormat } from '@/lib/view-request';

const CONTENT_TYPES = { csv: 'text/csv; charset=utf-8', json: 'application/json; charset=utf-8' } as const;

/** The records of a past scan that match the snapshot's filters and search, as CSV or JSON, streamed
 *  (ADR 0008). The query string is the snapshot route's own; the page in it is ignored, since a file
 *  holds every match. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  const search = new URL(req.url).searchParams;
  const format = parseExportFormat(search.get('format'));
  if (!format.ok) return Response.json({ error: format.error }, { status: 400 });

  try {
    const body = await streamSnapshotExport(openSnapshotExport(id, snapshotQueryFromParams(search)), format.value);
    return new Response(body, {
      headers: {
        'Content-Type': CONTENT_TYPES[format.value],
        'Content-Disposition': `attachment; filename="snapshot.${format.value}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    if (err instanceof SnapshotUnavailable) return NextResponse.json(SNAPSHOT_ERRORS[err.code].body, { status: SNAPSHOT_ERRORS[err.code].status });
    return serverError('Could not export the findings of this run', err);
  }
}
