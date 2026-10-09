import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { queryView } from '@/lib/db/finding-views';
import { parsePageSizeParam, parseViewRequest } from '@/lib/view-request';

export async function GET(req: Request) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  const params = new URL(req.url).searchParams;
  const request = parseViewRequest(params);
  if (!request.ok) return Response.json({ error: request.error }, { status: 400 });

  try {
    const { view, tab, showSuppressed } = request.value;
    const pageSize = parsePageSizeParam(params.get('pageSize'), view.pageSize);
    return Response.json(await queryView({ ...view, pageSize }, { tab, showSuppressed }));
  } catch (err) {
    return serverError('Could not load the findings', err);
  }
}
