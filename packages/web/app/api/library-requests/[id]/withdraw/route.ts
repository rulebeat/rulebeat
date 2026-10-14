import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { writeAudit } from '@/lib/db/audit';
import { withdrawLibraryRequest } from '@/lib/db/library-requests';
import { authorRequestView } from '@/lib/library-request-view';
import { NOT_FOUND } from '@/lib/personal-rule-request';

type Params = { params: Promise<{ id: string }> };

/** The author takes back their own open request. Someone else's request reads as missing, a reviewer's included. */
export async function POST(_req: Request, { params }: Params) {
  const actor = await requireRole('rules:personal');
  if (actor instanceof NextResponse) return actor;

  const id = decodeURIComponent((await params).id);
  try {
    const result = await withdrawLibraryRequest(id, actor.id);
    if (!result.ok) {
      if (result.reason === 'not-found') return NOT_FOUND();
      return NextResponse.json({ error: 'Only an open request can be withdrawn.' }, { status: 409 });
    }
    await writeAudit({
      actor,
      action: 'library_request.withdraw',
      entityType: 'library_request',
      entityId: id,
      summary: `Withdrew the library request for "${result.request.definition.name}"`,
      details: { personalRuleId: result.request.personalRuleId ?? null },
    });
    return NextResponse.json(await authorRequestView(result.request));
  } catch (err) {
    return serverError('Could not withdraw the request', err);
  }
}
