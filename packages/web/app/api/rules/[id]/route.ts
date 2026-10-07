import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { loadRules, updateRule, deleteRule, validateRuleName, ruleNameTakenError, APPLIES_TO_REMOVED_ERROR, type RuleChanges, type UpdateRuleResult } from '@/lib/rules';
import { writeAudit, changedFields } from '@/lib/db/audit';
import { createTenantContext } from '@/lib/azure-credential';
import { probeRuleIdentitySample } from '@/lib/rule-identity-check';
import { validateGraphQueryShape, probeGraphQuerySample } from '@/lib/graph-rule-validation';
import { validateLogAnalyticsQueryShape, probeLogAnalyticsQuerySample } from '@/lib/log-analytics-rule-validation';
import { sameValue } from '@/lib/rule-versions';
import { hasCompilableFilter } from '@rulebeat/core/kql';
import type { Rule } from '@rulebeat/core';

const BUILTIN_QUERY_LOCKED_ERROR =
  'A built-in rule\'s query cannot be edited. Duplicate the rule to get a custom copy you can change.';

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

  // Built-ins: only the enabled toggle and tag assignment are allowed. What a built-in runs changes
  // only through a version switch, so a different Graph query is refused and the caller is pointed
  // at Duplicate. A body that carries the stored query back unchanged (the Rules tab toggle sends
  // the whole rule) is not an edit of it.
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

  if ('appliesTo' in body) {
    return NextResponse.json({ error: APPLIES_TO_REMOVED_ERROR }, { status: 400 });
  }

  const nameError = validateRuleName(body.name);
  if (nameError) {
    return NextResponse.json({ error: nameError }, { status: 400 });
  }

  // RB-RM-004: same server-side guard as POST — see that route for the reasoning.
  if (body.visualQuery && !hasCompilableFilter(body.visualQuery)) {
    return NextResponse.json({
      error: 'The rule has no condition that compiles to a filter — it would match every resource in scope. Add at least one real condition.',
    }, { status: 400 });
  }

  // queryBackend can't change via edit (preserved from existing below), so existing.queryBackend is
  // the authoritative backend for this rule — same allowlist/structural/probe validation as POST.
  if (existing.queryBackend === 'microsoft-graph') {
    if (!body.graphQuery) {
      return NextResponse.json({ error: 'A Directory rule needs a Microsoft Graph query.' }, { status: 400 });
    }
    const shapeError = validateGraphQueryShape(body.graphQuery);
    if (shapeError) {
      return NextResponse.json({ error: shapeError }, { status: 400 });
    }
    try {
      const ctx = await createTenantContext();
      await probeGraphQuerySample(body.graphQuery, ctx);
    } catch (err) {
      console.error('[RuleBeat] rule-save Graph probe could not connect to Azure, allowing save:', err);
    }
  }

  if (existing.queryBackend === 'log-analytics') {
    if (!body.logsQuery) {
      return NextResponse.json({ error: 'A Log Analytics rule needs a query.' }, { status: 400 });
    }
    const shapeError = validateLogAnalyticsQueryShape(body.logsQuery);
    if (shapeError) {
      return NextResponse.json({ error: shapeError }, { status: 400 });
    }
    try {
      const ctx = await createTenantContext();
      await probeLogAnalyticsQuerySample(body.logsQuery, ctx);
    } catch (err) {
      console.error('[RuleBeat] rule-save Log Analytics probe could not connect to Azure, allowing save:', err);
    }
  }

  if (body.rawKql) {
    try {
      const ctx = await createTenantContext();
      const probe = await probeRuleIdentitySample(body.rawKql, ctx);
      if (probe.blocked) {
        return NextResponse.json({
          error: `${probe.invalidCount} of ${probe.sampleSize} sampled row(s) have no resource id — project id explicitly in the query`,
        }, { status: 400 });
      }
    } catch (err) {
      console.error('[RuleBeat] rule-save identity probe could not connect to Azure, allowing save:', err);
    }
  }

  // The form sends the whole editable definition, so every editable field is named here and one the
  // payload omits is cleared, as before. Type/pack/queryBackend/kind are left out so they cannot be
  // changed via edit, and so are the scan-outcome fields (lastRunStatus/lastRunAt): they are the
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
