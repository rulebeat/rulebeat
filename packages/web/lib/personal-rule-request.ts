import { NextResponse } from 'next/server';
import type { QueryBackend, Rule } from '@rulebeat/core';
import type { Access } from '@/lib/access-model';
import { resolveKind } from '@/lib/rules';
import { mayQueryDirectory, mayWriteQueries } from '@/lib/written-query';
import type { PersonalRuleDefinition } from '@/lib/db/personal-rules';

/** Only these two backends can be written as a Personal rule: Logs authoring is paused. */
export const PERSONAL_BACKENDS: readonly QueryBackend[] = ['resource-graph', 'microsoft-graph'];

export const NOT_FOUND = () => NextResponse.json({ error: 'Not found' }, { status: 404 });

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
