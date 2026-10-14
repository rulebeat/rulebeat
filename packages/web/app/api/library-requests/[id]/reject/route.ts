import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { writeAudit } from '@/lib/db/audit';
import { rejectLibraryRequest } from '@/lib/db/library-requests';
import { readOptionalJson } from '@/lib/library-request-view';
import { NOT_FOUND } from '@/lib/personal-rule-request';

type Params = { params: Promise<{ id: string }> };

/**
 * Rejects an open request with a reason the author reads on their Personal rule. The reason is a value,
 * so the audit entry names the rule and nothing of what the reviewer wrote.
 */
export async function POST(req: Request, { params }: Params) {
  const actor = await requireRole('rules:write');
  if (actor instanceof NextResponse) return actor;

  const body = await readOptionalJson(req);
  if (body instanceof NextResponse) return body;
  const reason = (body as { reason?: unknown } | null | undefined)?.reason;
  if (typeof reason !== 'string' || reason.trim() === '') {
    return NextResponse.json({ error: 'A rejection needs a reason the author can read.' }, { status: 400 });
  }

  const id = decodeURIComponent((await params).id);
  try {
    const result = await rejectLibraryRequest(id, actor.id, reason);
    if (!result.ok) {
      if (result.reason === 'not-found') return NOT_FOUND();
      return NextResponse.json({ error: 'This request is no longer open.' }, { status: 409 });
    }
    await writeAudit({
      actor,
      action: 'library_request.reject',
      entityType: 'library_request',
      entityId: id,
      summary: `Rejected the library request for "${result.request.definition.name}"`,
      details: { authorId: result.request.authorId },
    });
    return NextResponse.json({ id, status: result.request.status });
  } catch (err) {
    return serverError('Could not reject the request', err);
  }
}
