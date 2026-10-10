import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { queryGroup } from '@/lib/db/finding-views';
import { parseGroupPath, parsePageParam, parseViewRequest } from '@/lib/view-request';

export async function GET(req: Request) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  const params = new URL(req.url).searchParams;
  const request = parseViewRequest(params);
  if (!request.ok) return Response.json({ error: request.error }, { status: 400 });
  const groupPath = parseGroupPath(params.get('groupPath'));
  if (!groupPath.ok) return Response.json({ error: groupPath.error }, { status: 400 });

  try {
    const { view, tab, showSuppressed } = request.value;
    return Response.json(await queryGroup(view, {
      tab, showSuppressed, groupPath: groupPath.value, groupPage: parsePageParam(params.get('groupPage')),
    }));
  } catch (err) {
    return serverError('Could not load the group', err);
  }
}
