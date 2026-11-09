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
    const { view, tab, showSuppressed, savedRevision } = request.value;
    const answer = await queryView(view, { tab, showSuppressed }, actor.access);
    return Response.json(savedRevision === undefined ? answer : { ...answer, savedRevision });
  } catch (err) {
    return serverError('Could not load the findings', err);
  }
}
