import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { queryFindingRows } from '@/lib/db/finding-views';
import { readWithOpenView, withViewFlag } from '@/lib/open-saved-view';
import { parsePageParam, parseViewRequest } from '@/lib/view-request';

export async function GET(req: Request) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  const params = new URL(req.url).searchParams;
  const request = parseViewRequest(params);
  if (!request.ok) return Response.json({ error: request.error }, { status: 400 });
  const fingerprint = params.get('fingerprint');
  if (!fingerprint) return Response.json({ error: 'fingerprint is required.' }, { status: 400 });

  try {
    const { tab, showSuppressed } = request.value;
    const { view, viewMissing } = await readWithOpenView(actor, params, request.value.view);
    const rows = await queryFindingRows(view, { tab, showSuppressed, fingerprint, rowsPage: parsePageParam(params.get('rowsPage')) }, actor.access);
    if (!rows) return Response.json({ error: 'Finding not found.' }, { status: 404 });
    return Response.json(withViewFlag(rows, viewMissing));
  } catch (err) {
    return serverError('Could not load the finding rows', err);
  }
}
