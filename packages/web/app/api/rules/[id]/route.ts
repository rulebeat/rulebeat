import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { loadRules, updateRule, deleteRule, isNameTaken, validateRuleName, APPLIES_TO_REMOVED_ERROR, type RuleChanges } from '@/lib/rules';
import { writeAudit, changedFields } from '@/lib/db/audit';
import { createTenantContext } from '@/lib/azure-credential';
import { probeRuleIdentitySample } from '@/lib/rule-identity-check';
import { validateGraphQueryShape, probeGraphQuerySample } from '@/lib/graph-rule-validation';
import { validateLogAnalyticsQueryShape, probeLogAnalyticsQuerySample } from '@/lib/log-analytics-rule-validation';
import { hasCompilableFilter } from '@rulebeat/core/kql';
import type { Rule } from '@rulebeat/core';

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

  // Built-ins: only enabled toggle and tag assignment are allowed, with one exception (spec 032) —
  // a microsoft-graph built-in (the seeded identity checks) ships its detection logic editable, so
  // its graphQuery can also be tuned here without forking it into a custom copy first.
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

    if (existing.queryBackend === 'microsoft-graph' && body.graphQuery) {
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
      changes.graphQuery = body.graphQuery;
    }

    const updated = await updateRule(id, changes);
    if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    await writeAudit({
      actor,
      action: 'rule.update',
      entityType: 'rule',
      entityId: id,
      summary: changes.enabled !== existing.enabled
        ? `${changes.enabled ? 'Enabled' : 'Disabled'} built-in rule "${existing.name}"`
        : changes.graphQuery
          ? `Updated the Graph query on built-in rule "${existing.name}"`
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

  if (await isNameTaken(body.name, id)) {
    return NextResponse.json({ error: `A rule named "${body.name}" already exists. Rule names must be unique.` }, { status: 409 });
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
  const updated = await updateRule(id, changes);
  if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 });

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
