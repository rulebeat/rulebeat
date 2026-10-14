import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { loadRules, loadRule, createRule, copiedOrigin, ruleNameTakenError, resolveKind } from '@/lib/rules';
import { writeAudit } from '@/lib/db/audit';
import { narrowRulesScope } from '@/lib/rule-scope-access';
import { createTenantContext } from '@/lib/azure-credential';
import { validateRuleDefinition } from '@/lib/rule-definition-validation';
import type { QueryBackend, Rule } from '@rulebeat/core';

export async function GET() {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;
  // A person who does not hold Everything is not told the subscriptions or management groups a rule's
  // scope names beyond the ones they hold; the engine and the scheduler read the rules unnarrowed.
  return NextResponse.json(narrowRulesScope(await loadRules(), actor.access));
}

export async function POST(req: Request) {
  const actor = await requireRole('rules:write');
  if (actor instanceof NextResponse) return actor;

  // `copyFrom` is the id of the rule the form was duplicated from; it is not a Rule field.
  const body = await parseJsonBody<Omit<Rule, 'id'> & { copyFrom?: unknown; deadlineField?: unknown; groupField?: unknown }>(req);
  if (body instanceof NextResponse) return body;

  const queryBackend: QueryBackend = body.queryBackend ?? 'resource-graph';
  const checked = await validateRuleDefinition(body, queryBackend, {
    createContext: () => createTenantContext(actor.access),
    allowedBackends: ['resource-graph', 'microsoft-graph', 'log-analytics'],
  });
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });

  // A version, a retirement and an origin are the server's to set, never a request's: a custom rule
  // has no version of its own and is never retired, and its origin is the rule `copyFrom` names as
  // this server sees it. An unknown or non-string `copyFrom` records no origin and still creates.
  // The last run status and time are the scan's to write, so a new rule starts with neither.
  // `deadlineField` and `groupField` are settings rules no longer have; a client that still sends
  // them is ignored and never sees them echoed back.
  const {
    copyFrom, version: _v, retiredAt: _r, originRuleId: _o, originVersion: _ov,
    lastRunStatus: _ls, lastRunAt: _la,
    deadlineField: _df, groupField: _gf, ...fields
  } = body;
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
