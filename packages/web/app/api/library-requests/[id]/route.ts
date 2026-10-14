import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { getLibraryRequest } from '@/lib/db/library-requests';
import { requestDetail } from '@/lib/library-request-view';
import { NOT_FOUND } from '@/lib/personal-rule-request';

type Params = { params: Promise<{ id: string }> };

/** One request as a reviewer reads it: the snapshot, the query it generates, its scope and its author. */
export async function GET(_req: Request, { params }: Params) {
  const actor = await requireRole('rules:write');
  if (actor instanceof NextResponse) return actor;

  const request = await getLibraryRequest(decodeURIComponent((await params).id));
  if (!request) return NOT_FOUND();
  return NextResponse.json(await requestDetail(request));
}
