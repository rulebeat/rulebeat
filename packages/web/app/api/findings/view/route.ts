import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { queryView } from '@/lib/db/finding-views';
import { readViewRequest } from '@/lib/view-request';

export async function GET(req: Request) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  const params = new URL(req.url).searchParams;
  const request = await readViewRequest(params);
  if (!request.ok) return Response.json({ error: request.error }, { status: request.status });

  try {
    const { view, tab, showSuppressed } = request.value;
    const answer = await queryView(view, { tab, showSuppressed }, actor.access);
    // With a saved view open the answer says which revision of it was read, so a page opened on an older one can tell.
    return Response.json(request.saved ? { ...answer, savedView: request.saved } : answer);
  } catch (err) {
    return serverError('Could not load the findings', err);
  }
}
