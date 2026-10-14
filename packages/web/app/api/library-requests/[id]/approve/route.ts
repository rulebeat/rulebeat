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
import { ruleNameTakenError, loadRule } from '@/lib/rules';
import { changedFields } from '@/lib/changed-fields';
import { validateRuleDefinition } from '@/lib/rule-definition-validation';

type Params = { params: Promise<{ id: string }> };

const TARGET_GONE_ERROR = 'The library rule this request updates no longer exists. Reject the request so the author can send it as a new rule.';
const TARGET_NOT_CUSTOM_ERROR = 'The library rule this request updates is not a custom rule, and built-in rules change only by version.';
const TARGET_BACKEND_ERROR = 'The library rule this request updates uses a different kind of query than the request.';

/**
 * Approves an open request. A new-rule request becomes a new custom library rule. An update request (#283)
 * edits its target in place, keeping the rule's id, findings and suppressions, and answers 409 when the
 * target is gone or not custom. The body may carry `name`, `category`,
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
    if (request.targetRuleId) {
      const target = await loadRule(request.targetRuleId);
      if (!target) return NextResponse.json({ error: TARGET_GONE_ERROR }, { status: 409 });
      if (target.type !== 'custom') return NextResponse.json({ error: TARGET_NOT_CUSTOM_ERROR }, { status: 409 });
    }
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
      if (result.reason === 'target-gone') return NextResponse.json({ error: TARGET_GONE_ERROR }, { status: 409 });
      if (result.reason === 'not-custom') return NextResponse.json({ error: TARGET_NOT_CUSTOM_ERROR }, { status: 409 });
      if (result.reason === 'backend-mismatch') return NextResponse.json({ error: TARGET_BACKEND_ERROR }, { status: 409 });
      return NextResponse.json({ error: 'This request is no longer open.' }, { status: 409 });
    }

    if (result.before) {
      const { rule } = result;
      const written: Partial<Rule> = {
        name: rule.name, description: rule.description, category: rule.category, severity: rule.severity,
        enabled: rule.enabled, kind: rule.kind, tags: rule.tags, scope: rule.scope, resourceTypes: rule.resourceTypes,
        conditions: rule.conditions, conditionGroups: rule.conditionGroups, projectColumns: rule.projectColumns,
        rawKql: rule.rawKql, visualQuery: rule.visualQuery, graphQuery: rule.graphQuery,
      };
      await writeAudit({
        actor,
        action: 'library_request.approve',
        entityType: 'library_request',
        entityId: id,
        summary: `Approved the library request as an update to "${result.before.name}"`,
        details: {
          libraryRuleId: rule.id,
          targetRuleId: rule.id,
          update: true,
          changed: changedFields(result.before, written),
          edited: Object.keys(edits),
        },
      });
      return NextResponse.json({ request: { id, status: result.request.status }, rule }, { status: 201 });
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
