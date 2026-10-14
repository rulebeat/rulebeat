import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { loadRules, updateRule, deleteRule, ruleNameTakenError, resolveKind, ADVISORY_ON_LOGS_ERROR, APPLIES_TO_REMOVED_ERROR, type RuleChanges, type UpdateRuleResult } from '@/lib/rules';
import { writeAudit } from '@/lib/db/audit';
import { changedFields } from '@/lib/changed-fields';
import { createTenantContext } from '@/lib/azure-credential';
import { validateRuleDefinition } from '@/lib/rule-definition-validation';
import { sameValue } from '@/lib/rule-versions';
import type { Rule, RuleKind } from '@rulebeat/core';

const BUILTIN_QUERY_LOCKED_ERROR =
  'A built-in rule\'s query cannot be edited. Duplicate the rule to get a custom copy you can change.';
const BUILTIN_KIND_LOCKED_ERROR =
  "A built-in rule's kind is set by RuleBeat and cannot be changed. Duplicate the rule to get a custom copy you can change.";

/**
 * The kind an edit asks for, resolved against the rule's own backend (which an edit cannot
 * change): undefined when the body names none, so the stored kind stays; a 400 when a Logs rule
 * asks to be Advisory; otherwise the resolved kind, where a forged value falls back to 'state'.
 */
function requestedKindChange(existing: Rule, requested: unknown): RuleKind | undefined | NextResponse {
  if (requested === undefined) return undefined;
  const backend = existing.queryBackend ?? 'resource-graph';
  if (requested === 'advisory' && backend === 'log-analytics') {
    return NextResponse.json({ error: ADVISORY_ON_LOGS_ERROR }, { status: 400 });
  }
  return resolveKind(backend, requested as RuleKind);
}

/** Maps an `updateRule()` failure to the response both branches below return for it. */
function updateFailureResponse(result: Extract<UpdateRuleResult, { ok: false }>, name: string): NextResponse {
  return result.reason === 'not-found'
    ? NextResponse.json({ error: 'Not found' }, { status: 404 })
    : NextResponse.json(ruleNameTakenError(name), { status: 409 });
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await requireRole('rules:write');
  if (actor instanceof NextResponse) return actor;

  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);
  const existing = (await loadRules()).find(r => r.id === id);
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Built-ins: only the enabled toggle and tag assignment are allowed. What a built-in runs and its
  // kind change only through a version switch, so a different Graph query or kind is refused and the
  // caller is pointed at Duplicate. A body that carries the stored value back unchanged (the Rules
  // tab toggle sends the whole rule) is not an edit of it.
  if (existing.type === 'builtin') {
    const body = await parseJsonBody<Partial<Rule>>(req);
    if (body instanceof NextResponse) return body;
    if ('appliesTo' in body) {
      return NextResponse.json({ error: APPLIES_TO_REMOVED_ERROR }, { status: 400 });
    }

    // Only the fields this edit means to change are written, so a scan's run status or another
    // editor's change to a column untouched here is never put back to what was read above.
    const changes: RuleChanges = { enabled: Boolean(body.enabled) };
    const newTags = body.tags ?? (body.group ? [body.group] : undefined);
    if (newTags) changes.tags = newTags;
    if (body.kind !== undefined && body.kind !== existing.kind) {
      return NextResponse.json({ error: BUILTIN_KIND_LOCKED_ERROR }, { status: 400 });
    }
    if (body.graphQuery && !sameValue(body.graphQuery, existing.graphQuery)) {
      return NextResponse.json({ error: BUILTIN_QUERY_LOCKED_ERROR }, { status: 400 });
    }

    const result = await updateRule(id, changes);
    if (!result.ok) return updateFailureResponse(result, existing.name);
    const updated = result.rule;

    await writeAudit({
      actor,
      action: 'rule.update',
      entityType: 'rule',
      entityId: id,
      summary: changes.enabled !== existing.enabled
        ? `${changes.enabled ? 'Enabled' : 'Disabled'} built-in rule "${existing.name}"`
        : `Updated tags on built-in rule "${existing.name}"`,
      details: { changed: changedFields(existing, changes) },
    });

    return NextResponse.json(updated);
  }

  const body = await parseJsonBody<Rule>(req);
  if (body instanceof NextResponse) return body;

  // queryBackend can't change via edit (preserved from existing below), so existing.queryBackend is
  // the authoritative backend for this rule: same structural and probe validation as POST.
  const checked = await validateRuleDefinition(body, existing.queryBackend ?? 'resource-graph', {
    createContext: () => createTenantContext(actor.access),
  });
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });

  // The form sends the whole editable definition, so every editable field is named here and one the
  // payload omits is cleared, as before. Type/pack/queryBackend are left out so they cannot be
  // changed via edit (kind is added below, only when the body names one), and so are the scan-outcome fields (lastRunStatus/lastRunAt): they are the
  // scan's, `updateRule()` never writes them, and an edit can neither reset a rule's outcome history
  // to "never run" nor put back a stale one.
  const changes: RuleChanges = {
    name: body.name,
    description: body.description,
    category: body.category,
    severity: body.severity,
    enabled: body.enabled,
    scope: body.scope,
    resourceTypes: body.resourceTypes,
    conditions: body.conditions,
    conditionGroups: body.conditionGroups,
    projectColumns: body.projectColumns,
    rawKql: body.rawKql,
    group: body.group,
    tags: body.tags,
    visualQuery: body.visualQuery,
    graphQuery: body.graphQuery,
    logsQuery: body.logsQuery,
  };
  const kindChange = requestedKindChange(existing, body.kind);
  if (kindChange instanceof NextResponse) return kindChange;
  if (kindChange) changes.kind = kindChange;
  const result = await updateRule(id, changes);
  if (!result.ok) return updateFailureResponse(result, body.name);
  const updated = result.rule;

  await writeAudit({
    actor,
    action: 'rule.update',
    entityType: 'rule',
    entityId: id,
    summary: `Updated rule "${updated.name}"`,
    details: { changed: changedFields(existing, changes) },
  });

  return NextResponse.json(updated);
}

export async function DELETE(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await requireRole('rules:delete');
  if (actor instanceof NextResponse) return actor;

  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);
  const target = (await loadRules()).find(r => r.id === id);

  if (!target) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (target.type === 'builtin') return NextResponse.json({ error: 'Built-in rules cannot be deleted.' }, { status: 403 });

  if (!await deleteRule(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  await writeAudit({
    actor,
    action: 'rule.delete',
    entityType: 'rule',
    entityId: id,
    summary: `Deleted rule "${target.name}" and its findings`,
    details: { category: target.category, severity: target.severity },
  });

  return NextResponse.json({ success: true });
}
