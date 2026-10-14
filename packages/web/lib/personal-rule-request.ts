import { NextResponse } from 'next/server';
import type { QueryBackend, Rule } from '@rulebeat/core';
import type { Access } from '@/lib/access-model';
import { resolveKind } from '@/lib/rules';
import { can, type Role } from '@/lib/rbac';
import { LOGS_PAUSED_MESSAGE } from '@/lib/personal-rule-run';
import { NEEDS_SUBSCRIPTION_MESSAGE, mayQueryDirectory, mayWriteQueries } from '@/lib/written-query';
import type { PersonalRuleDefinition } from '@/lib/db/personal-rules';

/** Only these two backends can be written as a Personal rule: Logs authoring is paused. */
export const PERSONAL_BACKENDS: readonly QueryBackend[] = ['resource-graph', 'microsoft-graph'];

export const NOT_FOUND = () => NextResponse.json({ error: 'Not found' }, { status: 404 });

/** Why this person cannot write Personal rules at all, or null. Computed on the server for a disabled control. */
export function personalWriteBlockedReason(role: Role | undefined, access: Access): string | null {
  if (!role || !can(role, 'rules:personal')) {
    return 'Personal rules are written by Editors. You can read the ones you already have.';
  }
  return mayWriteQueries(access).ok ? null : NEEDS_SUBSCRIPTION_MESSAGE;
}

/** Per backend, why Copy to personal is off for this person (the same refusals `refuseWrite` gives), or null. */
export function personalCopyReasons(role: Role | undefined, access: Access): Record<QueryBackend, string | null> {
  const general = personalWriteBlockedReason(role, access);
  const directory = mayQueryDirectory(access);
  return {
    'resource-graph': general,
    'microsoft-graph': general ?? (directory.ok ? null : directory.error),
    'log-analytics': general ?? LOGS_PAUSED_MESSAGE,
  };
}

/**
 * The refusal a person who may not write or run a rule on this backend gets, or null. A Viewer never
 * reaches here: `requireRole('rules:personal')` refuses them first. An Editor whose access is only
 * resource groups is refused with the "needs a subscription" message, and a Microsoft Graph rule
 * also needs the Directory.
 */
export function refuseWrite(access: Access, backend: QueryBackend): NextResponse | null {
  const mayWrite = mayWriteQueries(access);
  if (!mayWrite.ok) return NextResponse.json({ error: mayWrite.error }, { status: 403 });
  if (backend === 'microsoft-graph') {
    const mayDirectory = mayQueryDirectory(access);
    if (!mayDirectory.ok) return NextResponse.json({ error: mayDirectory.error }, { status: 403 });
  }
  return null;
}

/**
 * The definition fields of a request, and only those. The server sets id, owner, times and the last
 * run; a client that sends a type, pack, version or last run has them ignored.
 */
export function definitionOf(body: Partial<Rule>, queryBackend: QueryBackend): PersonalRuleDefinition {
  return {
    name: (body.name ?? '').trim(),
    description: body.description ?? '',
    category: body.category ?? '',
    severity: body.severity ?? 'medium',
    queryBackend,
    kind: resolveKind(queryBackend, body.kind),
    tags: body.tags,
    scope: body.scope ?? { level: 'subscription' },
    resourceTypes: body.resourceTypes ?? [],
    conditions: body.conditions ?? [],
    conditionGroups: body.conditionGroups,
    projectColumns: body.projectColumns,
    rawKql: body.rawKql,
    visualQuery: body.visualQuery,
    graphQuery: queryBackend === 'microsoft-graph' ? body.graphQuery : undefined,
  };
}
