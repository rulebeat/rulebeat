import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { writeAudit } from '@/lib/db/audit';
import { createLibraryRequest } from '@/lib/db/library-requests';
import { getPersonalRule } from '@/lib/db/personal-rules';
import { authorRequestView, readOptionalJson } from '@/lib/library-request-view';
import { NOT_FOUND } from '@/lib/personal-rule-request';
import { loadRule } from '@/lib/rules';

type Params = { params: Promise<{ id: string }> };

/**
 * Sends the author's Personal rule to the library as a Library request (#282). The request keeps a
 * snapshot of the rule as it is now. `{ resubmits: <requestId> }` sends a rejected request again; it is
 * accepted only for the author's own rejected request on this same rule, and an update request keeps its
 * target. `{ updates: <ruleId> }` (#283) sends it as an update to that custom library rule instead of a new
 * rule: the id must be the rule's own library rule or the rule it was copied from, else 404.
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
  let updates: string | undefined;
  if (body !== undefined) {
    const asked = body as { resubmits?: unknown; updates?: unknown } | null;
    if (asked?.resubmits !== undefined && (typeof asked.resubmits !== 'string' || asked.resubmits === '')) {
      return NextResponse.json({ error: 'resubmits must be the id of a rejected request.' }, { status: 400 });
    }
    if (asked?.updates !== undefined && (typeof asked.updates !== 'string' || asked.updates === '')) {
      return NextResponse.json({ error: 'updates must be the id of a library rule.' }, { status: 400 });
    }
    resubmits = asked?.resubmits as string | undefined;
    updates = asked?.updates as string | undefined;
  }

  try {
    if (updates !== undefined) {
      if (updates !== rule.libraryRuleId && updates !== rule.sourceRuleId) return NOT_FOUND();
      const target = await loadRule(updates);
      if (!target) return NOT_FOUND();
      if (target.type !== 'custom') {
        return NextResponse.json({ error: BUILTIN_TARGET_ERROR }, { status: 400 });
      }
      if (target.queryBackend !== rule.queryBackend) {
        return NextResponse.json({ error: BACKEND_TARGET_ERROR }, { status: 400 });
      }
    }

    const created = await createLibraryRequest(rule, actor.id, resubmits, updates);
    if (!created.ok) {
      if (created.reason === 'resubmit-not-found') return NOT_FOUND();
      if (created.reason === 'target-not-custom') return NextResponse.json({ error: BUILTIN_TARGET_ERROR }, { status: 400 });
      if (created.reason === 'target-backend') return NextResponse.json({ error: BACKEND_TARGET_ERROR }, { status: 400 });
      const error = created.reason === 'already-open'
        ? 'This rule already has an open request. Withdraw it before sending another.'
        : created.reason === 'target-gone'
          ? 'The library rule this request updates no longer exists. Send the rule as a new rule instead.'
          : 'Only a rejected request can be sent again.';
      return NextResponse.json({ error }, { status: 409 });
    }
    const targetRuleId = created.request.targetRuleId;
    await writeAudit({
      actor,
      action: 'library_request.create',
      entityType: 'library_request',
      entityId: created.request.id,
      summary: targetRuleId
        ? `Sent the Personal rule "${rule.name}" to the library as an update${resubmits ? ' again' : ''}`
        : `Sent the Personal rule "${rule.name}" to the library${resubmits ? ' again' : ''}`,
      details: {
        personalRuleId: rule.id,
        backend: rule.queryBackend,
        resubmission: resubmits !== undefined,
        ...(targetRuleId ? { targetRuleId, update: true } : {}),
      },
    });
    return NextResponse.json(await authorRequestView(created.request), { status: 201 });
  } catch (err) {
    return serverError('Could not send the rule to the library', err);
  }
}

const BUILTIN_TARGET_ERROR = 'A copy of a built-in rule can only be sent as a new rule. Built-in rules change only by version.';
const BACKEND_TARGET_ERROR = 'This rule uses a different kind of query than the library rule it would update. Send it as a new rule.';
