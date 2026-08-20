import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { loadRules, saveRules, isNameTaken, deriveShape } from '@/lib/rules';
import { deleteFindingsForRule } from '@/lib/db/findings';
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
  const allRules = loadRules();
  const idx = allRules.findIndex(r => r.id === id);
  if (idx === -1) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const existing = allRules[idx];

  // Built-ins: only enabled toggle and tag assignment are allowed, with one exception (spec 032) —
  // a microsoft-graph built-in (the seeded identity checks) ships its detection logic editable, so
  // its graphQuery can also be tuned here without forking it into a custom copy first.
  if (existing.type === 'builtin') {
    const body = await parseJsonBody<Partial<Rule>>(req);
    if (body instanceof NextResponse) return body;

    let graphQuery = existing.graphQuery;
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
      graphQuery = body.graphQuery;
    }

    allRules[idx] = {
      ...existing,
      enabled: Boolean(body.enabled),
      tags: body.tags ?? (body.group ? [body.group] : existing.tags),
      graphQuery,
    };
    saveRules(allRules);

    writeAudit({
      actor,
      action: 'rule.update',
      entityType: 'rule',
      entityId: id,
      summary: allRules[idx].enabled !== existing.enabled
        ? `${allRules[idx].enabled ? 'Enabled' : 'Disabled'} built-in rule "${existing.name}"`
        : graphQuery !== existing.graphQuery
          ? `Updated the Graph query on built-in rule "${existing.name}"`
          : `Updated tags on built-in rule "${existing.name}"`,
      details: { changed: changedFields(existing, allRules[idx]) },
    });

    return NextResponse.json(allRules[idx]);
  }

  const body = await parseJsonBody<Rule>(req);
  if (body instanceof NextResponse) return body;

  if (isNameTaken(body.name, id)) {
    return NextResponse.json({ error: `A rule named "${body.name}" already exists. Rule names must be unique.` }, { status: 409 });
  }

  // RB-RM-004: same server-side guard as POST — see that route for the reasoning.
  if (body.visualQuery && !hasCompilableFilter(body.visualQuery)) {
    return NextResponse.json({
      error: 'The rule has no condition that compiles to a filter — it would match every resource in scope. Add at least one real condition.',
    }, { status: 400 });
  }

  // spec 031: same guard, applied to Applies-to — see POST for the reasoning.
  if (body.appliesTo && !hasCompilableFilter(body.appliesTo)) {
    return NextResponse.json({
      error: 'Applies-to has no condition that compiles to a filter — it would count every resource in scope. Add at least one real condition, or remove Applies-to.',
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

  // Preserve type/pack/taxonomy — cannot be changed via edit. shape is the one exception: it's
  // derived from the incoming appliesTo (spec 031), same as POST, not preserved from the old row —
  // an edit that adds or removes Applies-to must actually change what the rule's shape reports.
  //
  // Also preserve the scan-outcome fields (lastRunStatus/lastRunAt/lastPopulationCount): the form
  // never sends them (they aren't user-editable), and `body` is a bare payload the client built,
  // not a spread of `existing` — without this, every edit through this route silently reset a
  // rule's outcome history back to "never run", which made spec 030's coverage badge and this
  // spec's "X of Y affected" count both go blank the moment someone saved an unrelated change.
  allRules[idx] = {
    ...body,
    id,
    type: existing.type,
    pack: existing.pack,
    queryBackend: existing.queryBackend,
    shape: deriveShape(body.appliesTo),
    kind: existing.kind,
    lastRunStatus: existing.lastRunStatus,
    lastRunAt: existing.lastRunAt,
    lastPopulationCount: existing.lastPopulationCount,
  };
  saveRules(allRules);

  writeAudit({
    actor,
    action: 'rule.update',
    entityType: 'rule',
    entityId: id,
    summary: `Updated rule "${allRules[idx].name}"`,
    details: { changed: changedFields(existing, allRules[idx]) },
  });

  return NextResponse.json(allRules[idx]);
}

export async function DELETE(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await requireRole('rules:delete');
  if (actor instanceof NextResponse) return actor;

  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);
  const allRules = loadRules();
  const target = allRules.find(r => r.id === id);

  if (!target) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (target.type === 'builtin') return NextResponse.json({ error: 'Built-in rules cannot be deleted.' }, { status: 403 });

  saveRules(allRules.filter(r => r.id !== id));
  deleteFindingsForRule(id);

  writeAudit({
    actor,
    action: 'rule.delete',
    entityType: 'rule',
    entityId: id,
    summary: `Deleted rule "${target.name}" and its findings`,
    details: { category: target.category, severity: target.severity },
  });

  return NextResponse.json({ success: true });
}
