import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { queryColumnValues } from '@/lib/db/finding-views';
import { parseColumnParam, parseViewRequest } from '@/lib/view-request';

export async function GET(req: Request) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  const params = new URL(req.url).searchParams;
  const request = parseViewRequest(params);
  if (!request.ok) return Response.json({ error: request.error }, { status: 400 });
  const column = parseColumnParam(params.get('column'));
  if (!column.ok) return Response.json({ error: column.error }, { status: 400 });

  try {
    const { view, tab, showSuppressed } = request.value;
    return Response.json(await queryColumnValues(view, { tab, showSuppressed, column: column.value, q: params.get('valueQuery') ?? undefined }));
  } catch (err) {
    return serverError('Could not load the column values', err);
  }
}
