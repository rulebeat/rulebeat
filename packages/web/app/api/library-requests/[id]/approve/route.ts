import { NextResponse } from 'next/server';
import type { Rule } from '@rulebeat/core';
import { requireRole } from '@/lib/api-auth';
import { azureError } from '@/lib/api-error';
import { createTenantContext } from '@/lib/azure-credential';
import { writeAudit } from '@/lib/db/audit';
import { applyReviewEdits, approveLibraryRequest, getLibraryRequest } from '@/lib/db/library-requests';
import { categoryError, parseReviewEdits, readOptionalJson } from '@/lib/library-request-view';
import { limitedContext } from '@/lib/personal-rule-run';
import { NOT_FOUND, PERSONAL_BACKENDS } from '@/lib/personal-rule-request';
import { ruleNameTakenError } from '@/lib/rules';
import { validateRuleDefinition } from '@/lib/rule-definition-validation';

type Params = { params: Promise<{ id: string }> };

/**
 * Approves an open request as a new custom library rule. The body may carry `name`, `category`,
 * `severity`, `scope` and `enabled` and nothing else; every other field comes from the snapshot the
 * author sent. The result is held to the same checks as a rule created in the Library.
 */
export async function POST(req: Request, { params }: Params) {
  const actor = await requireRole('rules:write');
  if (actor instanceof NextResponse) return actor;

  const body = await readOptionalJson(req);
  if (body instanceof NextResponse) return body;
  const edits = parseReviewEdits(body);
  if (edits instanceof NextResponse) return edits;

  const id = decodeURIComponent((await params).id);
  try {
    const request = await getLibraryRequest(id);
    if (!request) return NOT_FOUND();
    if (request.status !== 'open') {
      return NextResponse.json({ error: 'This request is no longer open.' }, { status: 409 });
    }

    const definition = applyReviewEdits(request.definition, edits);
    const missingCategory = await categoryError(definition.category);
    if (missingCategory) return NextResponse.json({ error: missingCategory }, { status: 400 });

    const checked = await validateRuleDefinition(definition as Partial<Rule>, definition.queryBackend, {
      createContext: async () => limitedContext(await createTenantContext(actor.access), actor.access),
      allowedBackends: PERSONAL_BACKENDS,
    });
    if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });

    const result = await approveLibraryRequest(id, actor.id, edits);
    if (!result.ok) {
      if (result.reason === 'not-found') return NOT_FOUND();
      if (result.reason === 'name-taken') return NextResponse.json(ruleNameTakenError(definition.name), { status: 409 });
      return NextResponse.json({ error: 'This request is no longer open.' }, { status: 409 });
    }

    await writeAudit({
      actor,
      action: 'library_request.approve',
      entityType: 'library_request',
      entityId: id,
      summary: `Approved the library request for "${result.rule.name}" as a new rule`,
      details: {
        libraryRuleId: result.rule.id,
        category: result.rule.category,
        severity: result.rule.severity,
        enabled: result.rule.enabled,
        edited: Object.keys(edits),
      },
    });
    return NextResponse.json({ request: { id, status: result.request.status }, rule: result.rule }, { status: 201 });
  } catch (err) {
    return azureError('Could not approve the request', err);
  }
}
