import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { querySnapshot } from '@/lib/db/scan-snapshots';
import { SNAPSHOT_ERRORS } from '@/lib/snapshot-response';
import { snapshotQueryFromParams } from '@/lib/snapshot-query';

/** A past scan's findings, one page of them, with the total and the severity and rule facets, read from
 *  the scan's own records (ADR 0008). The query string is the snapshot's own (`lib/snapshot-query.ts`). */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  try {
    const answer = await querySnapshot(id, snapshotQueryFromParams(new URL(req.url).searchParams));
    if (answer.status === 'not-found') return NextResponse.json(SNAPSHOT_ERRORS['not-found'].body, { status: SNAPSHOT_ERRORS['not-found'].status });
    if (answer.status === 'no-records') return NextResponse.json(SNAPSHOT_ERRORS['no-records'].body, { status: SNAPSHOT_ERRORS['no-records'].status });
    return NextResponse.json(answer.response);
  } catch (err) {
    return serverError('Could not load the findings of this run', err);
  }
}
