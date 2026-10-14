import { NextResponse } from 'next/server';
import type { Rule, RuleScope, Severity } from '@rulebeat/core';
import type { AuthorLibraryRequest, LibraryRequestDetail, LibraryRequestSummary } from '@/lib/types';
import { buildRuleQuery } from '@rulebeat/core/kql';
import type { Access } from '@/lib/access-model';
import { isJsonContentType } from '@/lib/api-body';
import { getCategory } from '@/lib/db/categories';
import { getUser } from '@/lib/db/users';
import { applyReviewEdits, type LibraryRequest, type ReviewEdits } from '@/lib/db/library-requests';
import type { PersonalRuleDefinition } from '@/lib/db/personal-rules';
import { loadRule, loadRuleWithDefinition } from '@/lib/rules';
import { sameDefinition } from '@/lib/rule-versions';
import { diffQueryLines } from '@/lib/rule-version-preview';
import type { RuleDefinition } from '@/lib/shipped-catalogue';
import { mayAct } from '@/lib/rbac';
import { SEVERITY_ORDER } from '@/lib/severity';

/**
 * What the Library request routes and pages show, and how they read a reviewer's edits. Kept apart from
 * the repository so the shapes a person sees are decided in one place: an author sees the status of their
 * own requests, a reviewer sees the definition they are asked to approve.
 */

/** A request as its author sees it on the Personal rule: status, the reason when rejected, the rule it became. */
export type AuthorRequestView = AuthorLibraryRequest;

export async function authorRequestView(request: LibraryRequest): Promise<AuthorRequestView> {
  const rule = request.libraryRuleId ? await loadRule(request.libraryRuleId) : null;
  return {
    id: request.id,
    status: request.status,
    createdAt: request.createdAt,
    reviewedAt: request.reviewedAt,
    rejectionReason: request.rejectionReason,
    resubmitsRequestId: request.resubmitsRequestId,
    libraryRule: rule ? { id: rule.id, name: rule.name } : undefined,
    isUpdate: request.targetRuleId !== undefined,
    target: request.targetRuleId !== undefined ? await targetOf(request) : undefined,
  };
}

/** The rule an update request edits, or null once that rule is gone. Undefined for a new-rule request. */
async function targetOf(request: LibraryRequest): Promise<{ id: string; name: string } | null> {
  if (request.targetRuleId === undefined) return null;
  const rule = await loadRule(request.targetRuleId);
  return rule ? { id: rule.id, name: rule.name } : null;
}

/** One line of a list of open requests for a reviewer. */
export type RequestSummary = LibraryRequestSummary;

async function authorLabel(authorId: string): Promise<string> {
  const user = await getUser(authorId);
  return user ? (user.name?.trim() || user.email) : 'A removed user';
}

export async function requestSummary(request: LibraryRequest): Promise<RequestSummary> {
  return {
    id: request.id,
    name: request.definition.name,
    category: request.definition.category,
    severity: request.definition.severity,
    queryBackend: request.definition.queryBackend,
    createdAt: request.createdAt,
    author: { id: request.authorId, label: await authorLabel(request.authorId) },
    isResubmission: request.resubmitsRequestId !== undefined,
    isUpdate: request.targetRuleId !== undefined,
    target: request.targetRuleId !== undefined ? await targetOf(request) : undefined,
  };
}

/** The query as the rule would run it: a Resource Graph rule's KQL, or null for a Microsoft Graph rule, which has a graph query instead. */
export function generatedKql(definition: PersonalRuleDefinition): string | null {
  if (definition.queryBackend === 'microsoft-graph') return null;
  if (definition.rawKql) return definition.rawKql;
  return buildRuleQuery({ ...definition, id: '', type: 'custom', enabled: true } as Rule);
}

/** A stored rule's definition in the shape a request's snapshot has, so both sides of a diff render the same way. */
function asRequestDefinition(definition: RuleDefinition): PersonalRuleDefinition {
  return {
    name: definition.name,
    description: definition.description,
    category: definition.category as PersonalRuleDefinition['category'],
    severity: definition.severity as Severity,
    queryBackend: definition.queryBackend,
    kind: definition.kind,
    scope: definition.scope,
    resourceTypes: definition.resourceTypes,
    conditions: definition.conditions,
    conditionGroups: definition.conditionGroups ?? undefined,
    projectColumns: definition.projectColumns ?? undefined,
    rawKql: definition.rawKql ?? undefined,
    visualQuery: definition.visualQuery ?? undefined,
    graphQuery: definition.graphQuery ?? undefined,
  };
}

/**
 * A definition as text, one field per line, so two definitions line up in a diff: name, description,
 * category, severity, scope, then the query (the KQL, or a Microsoft Graph rule's query as JSON). Line
 * breaks inside a description collapse to a space so the description stays one line.
 */
export function definitionLines(definition: PersonalRuleDefinition): string {
  const scope = definition.scope;
  const scopeParts = [
    scope.level,
    ...(scope.managementGroups?.length ? [`management groups ${scope.managementGroups.join(', ')}`] : []),
    ...(scope.subscriptions?.length ? [`subscriptions ${scope.subscriptions.join(', ')}`] : []),
  ];
  const query = definition.queryBackend === 'microsoft-graph'
    ? JSON.stringify(definition.graphQuery ?? null, null, 2)
    : (generatedKql(definition) ?? '');
  return [
    `Name: ${definition.name}`,
    `Description: ${definition.description.replace(/\s*\r?\n\s*/g, ' ').trim()}`,
    `Category: ${definition.category}`,
    `Severity: ${definition.severity}`,
    `Scope: ${scopeParts.join('; ')}`,
    'Query:',
    query,
  ].join('\n');
}

/** A request as a reviewer reads it: the whole snapshot, the query it generates and who sent it. */
export type RequestDetail = LibraryRequestDetail;

/**
 * For an update request the detail also says whether the target changed since the request was sent, and
 * carries the line diff from the target as it is now to the sent definition with `edits` laid over it.
 */
export async function requestDetail(request: LibraryRequest, edits: ReviewEdits = {}): Promise<RequestDetail> {
  const detail: RequestDetail = {
    ...(await requestSummary(request)),
    status: request.status,
    description: request.definition.description,
    kql: generatedKql(request.definition),
    definition: request.definition,
    resubmitsRequestId: request.resubmitsRequestId,
  };
  if (request.targetRuleId === undefined) return detail;

  const current = await loadRuleWithDefinition(request.targetRuleId);
  const targetChanged = current === null
    ? false
    : request.targetDefinition === undefined || !sameDefinition(request.targetDefinition, current.definition);
  return {
    ...detail,
    targetChanged,
    targetEnabled: current?.rule.enabled,
    diff: current === null ? [] : diffQueryLines(
      definitionLines(asRequestDefinition(current.definition)),
      definitionLines(applyReviewEdits(request.definition, edits)),
    ),
  };
}

const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === 'string');
}

function parseScope(value: unknown): RuleScope | NextResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return bad('scope must be an object.');
  const raw = value as Record<string, unknown>;
  const levels = ['managementGroup', 'subscription', 'resourceGroup', 'resource'];
  if (typeof raw.level !== 'string' || !levels.includes(raw.level)) return bad('scope.level is not a known level.');
  for (const key of ['subscriptions', 'managementGroups'] as const) {
    if (raw[key] !== undefined && !isStringList(raw[key])) return bad(`scope.${key} must be a list of ids.`);
  }
  return {
    level: raw.level as RuleScope['level'],
    ...(raw.subscriptions !== undefined ? { subscriptions: raw.subscriptions as string[] } : {}),
    ...(raw.managementGroups !== undefined ? { managementGroups: raw.managementGroups as string[] } : {}),
  };
}

/**
 * Reads a reviewer's edits from a request body: `name`, `category`, `severity`, `scope` and `enabled`, and
 * nothing else. A key outside those is ignored, never carried into the rule. An empty body is no edits.
 */
export function parseReviewEdits(body: unknown): ReviewEdits | NextResponse {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) return bad('The request body must be a JSON object.');
  const raw = body as Record<string, unknown>;
  const edits: ReviewEdits = {};
  if (raw.name !== undefined) {
    if (typeof raw.name !== 'string') return bad('name must be text.');
    edits.name = raw.name;
  }
  if (raw.category !== undefined) {
    if (typeof raw.category !== 'string' || raw.category.trim() === '') return bad('category must be a category id.');
    edits.category = raw.category;
  }
  if (raw.severity !== undefined) {
    if (typeof raw.severity !== 'string' || !SEVERITY_ORDER.includes(raw.severity as Severity)) return bad('severity is not a known severity.');
    edits.severity = raw.severity as Severity;
  }
  if (raw.scope !== undefined) {
    const scope = parseScope(raw.scope);
    if (scope instanceof NextResponse) return scope;
    edits.scope = scope;
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') return bad('enabled must be true or false.');
    edits.enabled = raw.enabled;
  }
  return edits;
}

/**
 * The JSON body of a POST that may send none (the preview, the approval, a send with no resubmission).
 * An empty body reads as `undefined`; a body that is there must say it is JSON and parse.
 */
export async function readOptionalJson(req: Request): Promise<unknown | undefined | NextResponse> {
  const text = await req.text();
  if (text.trim() === '') return undefined;
  if (!isJsonContentType(req.headers.get('content-type'))) {
    return NextResponse.json({ error: 'Content-Type must be application/json.' }, { status: 415 });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return bad('Request body must be valid JSON.');
  }
}

/** Why a category cannot be used, or null when it exists. */
export async function categoryError(category: string): Promise<string | null> {
  return (await getCategory(category)) ? null : `There is no category "${category}".`;
}

/** Why this person cannot copy a Personal rule straight into the library, or null. Computed on the server for a disabled control. */
export const COPY_TO_LIBRARY_REASON =
  'Adding a rule to the library affects the whole install. It needs an Admin, or an Editor on Everything. Send it as a request instead.';

export function copyToLibraryBlockedReason(access: Access): string | null {
  return mayAct(access, 'rules:write') ? null : COPY_TO_LIBRARY_REASON;
}
