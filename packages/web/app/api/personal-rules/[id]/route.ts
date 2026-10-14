import { NextResponse } from 'next/server';
import type { Rule } from '@rulebeat/core';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { azureError } from '@/lib/api-error';
import { createTenantContext } from '@/lib/azure-credential';
import { writeAudit } from '@/lib/db/audit';
import { deletePersonalRule, getPersonalRule, listPersonalRuleResults, updatePersonalRule } from '@/lib/db/personal-rules';
import { listLibraryRequestsForPersonalRule, withdrawLibraryRequest } from '@/lib/db/library-requests';
import { authorRequestView } from '@/lib/library-request-view';
import { changedFields } from '@/lib/changed-fields';
import { limitedContext } from '@/lib/personal-rule-run';
import { NOT_FOUND, definitionOf, refuseWrite } from '@/lib/personal-rule-request';
import { validateRuleDefinition } from '@/lib/rule-definition-validation';

type Params = { params: Promise<{ id: string }> };

const idOf = async ({ params }: Params) => decodeURIComponent((await params).id);

/** One Personal rule with its latest results and the history of its Library requests. Any id the caller does not own answers 404, an Admin's too. */
export async function GET(_req: Request, ctx: Params) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  const id = await idOf(ctx);
  const rule = await getPersonalRule(id, actor.id);
  if (!rule) return NOT_FOUND();
  const requests = await listLibraryRequestsForPersonalRule(id, actor.id);
  return NextResponse.json({
    rule,
    results: await listPersonalRuleResults(id, actor.id),
    libraryRequests: await Promise.all(requests.map(authorRequestView)),
  });
}

export async function PUT(req: Request, ctx: Params) {
  const actor = await requireRole('rules:personal');
  if (actor instanceof NextResponse) return actor;

  const id = await idOf(ctx);
  const existing = await getPersonalRule(id, actor.id);
  if (!existing) return NOT_FOUND();

  const body = await parseJsonBody<Partial<Rule>>(req);
  if (body instanceof NextResponse) return body;

  // The backend cannot change on an edit, as for a shared rule.
  const queryBackend = existing.queryBackend ?? 'resource-graph';
  const refused = refuseWrite(actor.access, queryBackend);
  if (refused) return refused;

  try {
    const checked = await validateRuleDefinition(body, queryBackend, {
      createContext: async () => limitedContext(await createTenantContext(actor.access), actor.access),
    });
    if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });

    const definition = definitionOf(body, queryBackend);
    const updated = await updatePersonalRule(id, actor.id, definition);
    if (!updated) return NOT_FOUND();
    await writeAudit({
      actor,
      action: 'personal_rule.update',
      entityType: 'personal_rule',
      entityId: id,
      summary: `Edited the Personal rule "${updated.name}"`,
      details: { changed: changedFields(existing, definition) },
    });
    return NextResponse.json(updated);
  } catch (err) {
    return azureError('Could not save the Personal rule', err);
  }
}

export async function DELETE(_req: Request, ctx: Params) {
  const actor = await requireRole('rules:personal');
  if (actor instanceof NextResponse) return actor;

  const id = await idOf(ctx);
  const existing = await getPersonalRule(id, actor.id);
  if (!existing) return NOT_FOUND();

  // An open request for a rule that is going away is the author's to take back, so it is withdrawn with it.
  const open = (await listLibraryRequestsForPersonalRule(id, actor.id)).find(request => request.status === 'open');
  const withdrawn = open ? await withdrawLibraryRequest(open.id, actor.id) : null;
  if (!(await deletePersonalRule(id, actor.id))) return NOT_FOUND();
  if (withdrawn?.ok) {
    await writeAudit({
      actor,
      action: 'library_request.withdraw',
      entityType: 'library_request',
      entityId: withdrawn.request.id,
      summary: `Withdrew the library request for "${existing.name}" because the Personal rule was deleted`,
      details: { personalRuleId: id, reason: 'rule deleted' },
    });
  }
  await writeAudit({
    actor,
    action: 'personal_rule.delete',
    entityType: 'personal_rule',
    entityId: id,
    summary: `Deleted the Personal rule "${existing.name}"`,
  });
  return NextResponse.json({ ok: true });
}
