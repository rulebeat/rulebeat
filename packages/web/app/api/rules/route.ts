import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { loadRules, loadRule, createRule, copiedOrigin, validateRuleName, ruleNameTakenError, resolveKind, ADVISORY_ON_LOGS_ERROR, APPLIES_TO_REMOVED_ERROR } from '@/lib/rules';
import { writeAudit } from '@/lib/db/audit';
import { createTenantContext } from '@/lib/azure-credential';
import { probeRuleIdentitySample } from '@/lib/rule-identity-check';
import { validateGraphQueryShape, probeGraphQuerySample } from '@/lib/graph-rule-validation';
import { validateLogAnalyticsQueryShape, probeLogAnalyticsQuerySample } from '@/lib/log-analytics-rule-validation';
import { hasCompilableFilter } from '@rulebeat/core/kql';
import type { QueryBackend, Rule } from '@rulebeat/core';

export async function GET() {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;
  return NextResponse.json(await loadRules());
}

export async function POST(req: Request) {
  const actor = await requireRole('rules:write');
  if (actor instanceof NextResponse) return actor;

  // `copyFrom` is the id of the rule the form was duplicated from; it is not a Rule field.
  const body = await parseJsonBody<Omit<Rule, 'id'> & { copyFrom?: unknown }>(req);
  if (body instanceof NextResponse) return body;

  if ('appliesTo' in body) {
    return NextResponse.json({ error: APPLIES_TO_REMOVED_ERROR }, { status: 400 });
  }

  const nameError = validateRuleName(body.name);
  if (nameError) {
    return NextResponse.json({ error: nameError }, { status: 400 });
  }

  // spec 036: all three backends now have a real editor/engine — resource-graph and
  // microsoft-graph (spec 032), and log-analytics as of this spec.
  const queryBackend: QueryBackend = body.queryBackend ?? 'resource-graph';
  if (queryBackend !== 'resource-graph' && queryBackend !== 'microsoft-graph' && queryBackend !== 'log-analytics') {
    return NextResponse.json({ error: `"${queryBackend}" rules cannot be authored yet.` }, { status: 400 });
  }

  if (body.kind === 'advisory' && queryBackend === 'log-analytics') {
    return NextResponse.json({ error: ADVISORY_ON_LOGS_ERROR }, { status: 400 });
  }

  // RB-RM-004: the UI guard (rule-form.tsx's save()) is client-side only — an API caller submitting
  // the same visualQuery shape the form does must be held to the same "at least one condition
  // actually compiles" bar, or a filterless query (matches every resource in scope) saves directly.
  if (body.visualQuery && !hasCompilableFilter(body.visualQuery)) {
    return NextResponse.json({
      error: 'The rule has no condition that compiles to a filter — it would match every resource in scope. Add at least one real condition.',
    }, { status: 400 });
  }

  if (queryBackend === 'microsoft-graph') {
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
      // No Azure credential configured yet, or connecting failed outright — fail open, same as the
      // KQL identity probe below (see probeGraphQuerySample).
      console.error('[RuleBeat] rule-save Graph probe could not connect to Azure, allowing save:', err);
    }
  }

  if (queryBackend === 'log-analytics') {
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
      // No Azure credential/workspace configured yet, or connecting failed outright — fail open,
      // same as the Graph probe above.
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
      // No Azure credential configured yet, or connecting failed outright — fail open, same as a
      // probe query error (see probeRuleIdentitySample).
      console.error('[RuleBeat] rule-save identity probe could not connect to Azure, allowing save:', err);
    }
  }

  // A version, a retirement and an origin are the server's to set, never a request's: a custom rule
  // has no version of its own and is never retired, and its origin is the rule `copyFrom` names as
  // this server sees it. An unknown or non-string `copyFrom` records no origin and still creates.
  const { copyFrom, version: _v, retiredAt: _r, originRuleId: _o, originVersion: _ov, ...fields } = body;
  const source = typeof copyFrom === 'string' && copyFrom !== '' ? await loadRule(copyFrom) : null;

  const rule: Rule = {
    ...fields,
    id: globalThis.crypto.randomUUID(),
    type: 'custom',
    pack: undefined,
    queryBackend,
    kind: resolveKind(queryBackend, body.kind),
    ...(source ? copiedOrigin(source) : {}),
  };
  const result = await createRule(rule);
  if (!result.ok) {
    return NextResponse.json(ruleNameTakenError(rule.name), { status: 409 });
  }

  await writeAudit({
    actor,
    action: 'rule.create',
    entityType: 'rule',
    entityId: rule.id,
    summary: `Created rule "${rule.name}"`,
    details: { category: rule.category, severity: rule.severity, enabled: rule.enabled },
  });

  return NextResponse.json(result.rule, { status: 201 });
}
