import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { azureError } from '@/lib/api-error';
import { createTenantContext } from '@/lib/azure-credential';
import { writeAudit } from '@/lib/db/audit';
import { applyReviewEdits, getLibraryRequest } from '@/lib/db/library-requests';
import type { PersonalRule } from '@/lib/db/personal-rules';
import { parseReviewEdits, readOptionalJson } from '@/lib/library-request-view';
import { viewCoveredScope } from '@/lib/covered-scope-view';
import { labelCoveredScope } from '@/lib/run-scope';
import { limitedContext, planPersonalRun, runPersonalRule } from '@/lib/personal-rule-run';
import { NOT_FOUND } from '@/lib/personal-rule-request';

type Params = { params: Promise<{ id: string }> };

/**
 * Runs the request's query once, at the reviewer's own access, and returns what it found. It stores
 * nothing: no finding, scan, Personal rule result or last-run field is written, and the reviewer sees
 * the rows only in this response. The body may carry the `scope` the reviewer is trying out.
 */
export async function POST(req: Request, { params }: Params) {
  const actor = await requireRole('rules:write');
  if (actor instanceof NextResponse) return actor;

  const body = await readOptionalJson(req);
  if (body instanceof NextResponse) return body;
  const edits = parseReviewEdits(body);
  if (edits instanceof NextResponse) return edits;

  const id = decodeURIComponent((await params).id);
  const request = await getLibraryRequest(id);
  if (!request) return NOT_FOUND();
  if (request.status !== 'open') {
    return NextResponse.json({ error: 'This request is no longer open.' }, { status: 409 });
  }

  const definition = applyReviewEdits(request.definition, { scope: edits.scope });
  // A rule in the shape the run reads. It is never stored: the id, owner and times are placeholders.
  const rule = {
    ...definition, id: request.id, ownerId: actor.id, enabled: true, type: 'custom',
    createdAt: request.createdAt, updatedAt: request.createdAt,
  } as PersonalRule;

  const plan = planPersonalRun(rule, actor.access);
  if (!plan.ok) return NextResponse.json({ error: plan.error }, { status: 403 });

  try {
    const ctx = limitedContext(await createTenantContext(actor.access), actor.access);
    const { status, results } = await runPersonalRule(rule, ctx);
    const covered = labelCoveredScope(plan.covered, actor.access).map(entry => entry.label);

    await writeAudit({
      actor,
      action: 'library_request.preview',
      entityType: 'library_request',
      entityId: id,
      summary: `Previewed the library request for "${definition.name}" over ${covered.join(', ')}`,
      details: { status, findings: results.length },
    });
    return NextResponse.json({ status, results, covered: viewCoveredScope(plan.covered, actor.access), ranAt: new Date().toISOString() });
  } catch (err) {
    return azureError('Could not run the preview', err);
  }
}
