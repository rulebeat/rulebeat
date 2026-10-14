import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { writeAudit } from '@/lib/db/audit';
import { createLibraryRequest } from '@/lib/db/library-requests';
import { getPersonalRule } from '@/lib/db/personal-rules';
import { authorRequestView, readOptionalJson } from '@/lib/library-request-view';
import { NOT_FOUND } from '@/lib/personal-rule-request';

type Params = { params: Promise<{ id: string }> };

/**
 * Sends the author's Personal rule to the library as a Library request (#282). The request keeps a
 * snapshot of the rule as it is now. `{ resubmits: <requestId> }` sends a rejected request again; it is
 * accepted only for the author's own rejected request on this same rule.
 */
export async function POST(req: Request, { params }: Params) {
  const actor = await requireRole('rules:personal');
  if (actor instanceof NextResponse) return actor;

  const id = decodeURIComponent((await params).id);
  const rule = await getPersonalRule(id, actor.id);
  if (!rule) return NOT_FOUND();

  const body = await readOptionalJson(req);
  if (body instanceof NextResponse) return body;
  let resubmits: string | undefined;
  if (body !== undefined) {
    const asked = (body as { resubmits?: unknown } | null)?.resubmits;
    if (asked !== undefined && (typeof asked !== 'string' || asked === '')) {
      return NextResponse.json({ error: 'resubmits must be the id of a rejected request.' }, { status: 400 });
    }
    resubmits = asked;
  }

  try {
    const created = await createLibraryRequest(rule, actor.id, resubmits);
    if (!created.ok) {
      if (created.reason === 'resubmit-not-found') return NOT_FOUND();
      const error = created.reason === 'already-open'
        ? 'This rule already has an open request. Withdraw it before sending another.'
        : 'Only a rejected request can be sent again.';
      return NextResponse.json({ error }, { status: 409 });
    }
    await writeAudit({
      actor,
      action: 'library_request.create',
      entityType: 'library_request',
      entityId: created.request.id,
      summary: `Sent the Personal rule "${rule.name}" to the library${resubmits ? ' again' : ''}`,
      details: { personalRuleId: rule.id, backend: rule.queryBackend, resubmission: resubmits !== undefined },
    });
    return NextResponse.json(await authorRequestView(created.request), { status: 201 });
  } catch (err) {
    return serverError('Could not send the rule to the library', err);
  }
}
