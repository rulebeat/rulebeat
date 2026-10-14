/**
 * The line diff an update request shows its reviewer, as pure functions so the review page can redraw it
 * while the reviewer edits and the server can answer the same lines. Client-safe: no Node, no database.
 */
import { diffQueryLines, type QueryDiffLine } from '@/lib/rule-version-preview';
import type { LibraryRequestDetail, RuleScope, Severity } from '@/lib/types';

/** The fields of a definition its lines are made of. The query comes already written. */
export interface DefinitionFields {
  name: string;
  description: string;
  category: string;
  severity: string;
  scope: RuleScope;
}

/**
 * A definition as text, one field per line, so two definitions line up in a diff: name, description,
 * category, severity, scope, then the query. Line breaks inside a description collapse to a space so the
 * description stays one line.
 */
export function definitionLinesOf(fields: DefinitionFields, query: string): string {
  const scope = fields.scope;
  const scopeParts = [
    scope.level,
    ...(scope.managementGroups?.length ? [`management groups ${scope.managementGroups.join(', ')}`] : []),
    ...(scope.subscriptions?.length ? [`subscriptions ${scope.subscriptions.join(', ')}`] : []),
  ];
  return [
    `Name: ${fields.name}`,
    `Description: ${fields.description.replace(/\s*\r?\n\s*/g, ' ').trim()}`,
    `Category: ${fields.category}`,
    `Severity: ${fields.severity}`,
    `Scope: ${scopeParts.join('; ')}`,
    'Query:',
    query,
  ].join('\n');
}

/** What a reviewer can change before approving that shows in the diff. The query is never theirs to change. */
export interface DiffEdits {
  name: string;
  category: string;
  severity: Severity;
  scope: RuleScope;
}

/**
 * The diff from the target as it is now to the sent definition with the reviewer's edits laid over it, the
 * same lines the server answers for those edits. Null on a new-rule request, or once the target is gone.
 */
export function reviewDiff(
  request: Pick<LibraryRequestDetail, 'definition' | 'description' | 'kql' | 'targetLines'>, edits: DiffEdits,
): QueryDiffLine[] | null {
  if (request.targetLines === undefined) return null;
  const query = request.definition.queryBackend === 'microsoft-graph'
    ? JSON.stringify(request.definition.graphQuery ?? null, null, 2)
    : (request.kql ?? '');
  return diffQueryLines(request.targetLines, definitionLinesOf({
    name: edits.name.trim(), description: request.description, category: edits.category, severity: edits.severity, scope: edits.scope,
  }, query));
}
