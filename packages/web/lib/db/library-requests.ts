import { db } from './client';
import { libraryRequests } from './tables';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { many, one, run, inTransaction, pgAdvisoryXactLock } from './exec';
import { LIBRARY_REQUEST_LOCK_KEY } from './library-request-cleanup';
import type { Rule, RuleScope, Severity } from '@rulebeat/core';
import { RULE_NAME_LOCK_KEY, insertRuleOn, loadRuleWithDefinition, resolveKind, updateRuleOn, type RuleChanges } from '@/lib/rules';
import type { RuleDefinition } from '@/lib/shipped-catalogue';
import {
  definitionOfPersonalRule, getPersonalRule, setPersonalRuleLibraryRule, type PersonalRule, type PersonalRuleDefinition,
} from './personal-rules';

/**
 * Library requests (#282, ADR 0011): an Editor sends one of their Personal rules to the library, and an
 * Admin or an Editor on Everything approves it as a new custom rule or rejects it with a reason. The
 * request holds a snapshot of the rule's definition taken when it was sent, so editing the Personal rule
 * afterwards never changes what a reviewer reads. This file does no authorization: the routes decide who
 * may call each function, and every author-side read here names the author.
 */

export type LibraryRequestStatus = 'open' | 'approved' | 'rejected' | 'withdrawn';

export interface LibraryRequest {
  id: string;
  /** Null once the Personal rule is gone (its owner was removed). */
  personalRuleId?: string;
  authorId: string;
  /** The Personal rule as it was when the request was sent. */
  definition: PersonalRuleDefinition;
  status: LibraryRequestStatus;
  createdAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  rejectionReason?: string;
  /** The rejected request this one sends again. */
  resubmitsRequestId?: string;
  /** The library rule an approval created, or the one an approved update edited. */
  libraryRuleId?: string;
  /** For an update request: the custom library rule it edits in place (#283). Kept even after that rule is deleted. */
  targetRuleId?: string;
  /** The target's definition when the request was sent, to tell a reviewer the rule changed since. */
  targetDefinition?: RuleDefinition;
}

type Row = typeof libraryRequests.$inferSelect;


function parseDefinition(raw: string): PersonalRuleDefinition {
  return JSON.parse(raw) as PersonalRuleDefinition;
}

function rowToRequest(row: Row): LibraryRequest {
  return {
    id: row.id,
    personalRuleId: row.personalRuleId ?? undefined,
    authorId: row.authorId,
    definition: parseDefinition(row.definition),
    status: row.status as LibraryRequestStatus,
    createdAt: row.createdAt,
    reviewedBy: row.reviewedBy ?? undefined,
    reviewedAt: row.reviewedAt ?? undefined,
    rejectionReason: row.rejectionReason ?? undefined,
    resubmitsRequestId: row.resubmitsRequestId ?? undefined,
    libraryRuleId: row.libraryRuleId ?? undefined,
    targetRuleId: row.targetRuleId ?? undefined,
    targetDefinition: row.targetDefinition ? JSON.parse(row.targetDefinition) as RuleDefinition : undefined,
  };
}

/** What a reviewer may change on the way in. Every other field comes from the snapshot. */
export interface ReviewEdits {
  name?: string;
  category?: string;
  severity?: Severity;
  scope?: RuleScope;
  /** The rule's starting state. A new library rule starts disabled unless the reviewer says otherwise. */
  enabled?: boolean;
}

/** The snapshot with the reviewer's edits laid over it: the definition that is previewed, validated and approved. */
export function applyReviewEdits(definition: PersonalRuleDefinition, edits: ReviewEdits): PersonalRuleDefinition {
  return {
    ...definition,
    name: edits.name !== undefined ? edits.name.trim() : definition.name,
    category: edits.category ?? definition.category,
    severity: edits.severity ?? definition.severity,
    scope: edits.scope ?? definition.scope,
  };
}

function libraryRuleFrom(definition: PersonalRuleDefinition, enabled: boolean, libraryRequestId?: string): Rule {
  return {
    id: globalThis.crypto.randomUUID(),
    name: definition.name,
    description: definition.description,
    category: definition.category,
    severity: definition.severity,
    enabled,
    type: 'custom',
    pack: undefined,
    queryBackend: definition.queryBackend,
    kind: resolveKind(definition.queryBackend, definition.kind),
    tags: definition.tags,
    scope: definition.scope,
    resourceTypes: definition.resourceTypes,
    conditions: definition.conditions,
    conditionGroups: definition.conditionGroups,
    projectColumns: definition.projectColumns,
    rawKql: definition.rawKql,
    visualQuery: definition.visualQuery,
    graphQuery: definition.graphQuery,
    ...(libraryRequestId ? { libraryRequestId } : {}),
  };
}

export type CreateRequestResult =
  | { ok: true; request: LibraryRequest }
  | { ok: false; reason: 'already-open' | 'resubmit-not-found' | 'resubmit-not-rejected' | 'target-gone' | 'target-not-custom' | 'target-backend' };

/**
 * Sends the author's Personal rule: stores a snapshot of it as a new open request. Refuses when the rule
 * already has an open request. `resubmits` names a request this one sends again, and is accepted only
 * when that request is the author's own, belongs to this rule and was rejected.
 *
 * `targetRuleId` makes it an update request (#283): the library rule it would edit in place, stored with
 * a snapshot of that rule's definition. A resubmission with no target of its own keeps the one the
 * rejected request had. The target must exist, be `custom` and run on the same backend as the rule. Which
 * rules this author may name is the route's decision.
 */
export async function createLibraryRequest(
  rule: PersonalRule, authorId: string, resubmits?: string, targetRuleId?: string,
): Promise<CreateRequestResult> {
  return inTransaction(async (tx) => {
    await pgAdvisoryXactLock(tx, LIBRARY_REQUEST_LOCK_KEY);

    const open = await one(tx.select({ id: libraryRequests.id }).from(libraryRequests)
      .where(and(eq(libraryRequests.personalRuleId, rule.id), eq(libraryRequests.status, 'open'))));
    if (open) return { ok: false, reason: 'already-open' };

    let target = targetRuleId;
    if (resubmits !== undefined) {
      const earlier = await one(tx.select().from(libraryRequests).where(and(
        eq(libraryRequests.id, resubmits),
        eq(libraryRequests.authorId, authorId),
        eq(libraryRequests.personalRuleId, rule.id),
      )));
      if (!earlier) return { ok: false, reason: 'resubmit-not-found' };
      if (earlier.status !== 'rejected') return { ok: false, reason: 'resubmit-not-rejected' };
      target ??= earlier.targetRuleId ?? undefined;
    }

    let targetDefinition: string | null = null;
    if (target !== undefined) {
      const current = await loadRuleWithDefinition(target, tx);
      if (!current) return { ok: false, reason: 'target-gone' };
      if (current.rule.type !== 'custom') return { ok: false, reason: 'target-not-custom' };
      if (current.rule.queryBackend !== rule.queryBackend) return { ok: false, reason: 'target-backend' };
      targetDefinition = JSON.stringify(current.definition);
    }

    const id = globalThis.crypto.randomUUID();
    await run(tx.insert(libraryRequests).values({
      id,
      personalRuleId: rule.id,
      authorId,
      definition: JSON.stringify(definitionOfPersonalRule(rule)),
      status: 'open',
      createdAt: new Date().toISOString(),
      reviewedBy: null,
      reviewedAt: null,
      rejectionReason: null,
      resubmitsRequestId: resubmits ?? null,
      libraryRuleId: null,
      targetRuleId: target ?? null,
      targetDefinition,
    }));
    const stored = await one(tx.select().from(libraryRequests).where(eq(libraryRequests.id, id)));
    return { ok: true, request: rowToRequest(stored!) };
  });
}

/** Every open request, oldest first. Reviewers only: the route decides. */
export async function listOpenLibraryRequests(): Promise<LibraryRequest[]> {
  const rows = await many(db.select().from(libraryRequests)
    .where(eq(libraryRequests.status, 'open')).orderBy(asc(libraryRequests.createdAt)));
  return rows.map(rowToRequest);
}

export async function countOpenLibraryRequests(): Promise<number> {
  const row = await one(db.select({ n: sql<number>`count(*)` }).from(libraryRequests)
    .where(eq(libraryRequests.status, 'open')));
  return Number(row?.n ?? 0);
}

/** One request by id, whoever wrote it. Reviewers only: the route decides. */
export async function getLibraryRequest(id: string): Promise<LibraryRequest | null> {
  const row = await one(db.select().from(libraryRequests).where(eq(libraryRequests.id, id)));
  return row ? rowToRequest(row) : null;
}

/** Null both for a request that does not exist and for one that belongs to someone else. */
export async function getLibraryRequestOf(id: string, authorId: string): Promise<LibraryRequest | null> {
  const row = await one(db.select().from(libraryRequests)
    .where(and(eq(libraryRequests.id, id), eq(libraryRequests.authorId, authorId))));
  return row ? rowToRequest(row) : null;
}

/** The author's requests for one Personal rule, newest first. */
export async function listLibraryRequestsForPersonalRule(personalRuleId: string, authorId: string): Promise<LibraryRequest[]> {
  const rows = await many(db.select().from(libraryRequests)
    .where(and(eq(libraryRequests.personalRuleId, personalRuleId), eq(libraryRequests.authorId, authorId)))
    .orderBy(desc(libraryRequests.createdAt)));
  return rows.map(rowToRequest);
}

export type ApproveResult =
  | { ok: true; rule: Rule; request: LibraryRequest; before?: Rule }
  | { ok: false; reason: 'not-found' | 'not-open' | 'name-taken' | 'target-gone' | 'not-custom' |   'backend-mismatch' };

/** The definition fields an update writes onto the target. Never id, type, pack, queryBackend, version or origin fields, or a run outcome. */
function changesFrom(definition: PersonalRuleDefinition, enabled: boolean | undefined): RuleChanges {
  return {
    name: definition.name,
    description: definition.description,
    category: definition.category,
    severity: definition.severity,
    kind: resolveKind(definition.queryBackend, definition.kind),
    tags: definition.tags,
    scope: definition.scope,
    resourceTypes: definition.resourceTypes,
    conditions: definition.conditions,
    conditionGroups: definition.conditionGroups,
    projectColumns: definition.projectColumns,
    rawKql: definition.rawKql,
    visualQuery: definition.visualQuery,
    graphQuery: definition.graphQuery,
    ...(enabled !== undefined ? { enabled } : {}),
  };
}

/**
 * Approves an open request in one transaction: the name is checked under the same lock `createRule()`
 * takes, the request is closed with its reviewer, time and rule, and the Personal rule is pointed at that
 * rule. A request that is no longer open is refused; a name clash writes nothing and leaves the request open.
 *
 * A new-rule request inserts the library rule with a new id and the request's id. An update request (#283)
 * re-reads its target under the locks and writes the reviewed definition onto the same id, so the rule's
 * findings, suppressions and ages stay as they are. It is refused when the target is gone, is not `custom`
 * (a built-in changes only by version) or runs on another backend. The target keeps its enabled state
 * unless the reviewer sets one.
 */
export async function approveLibraryRequest(id: string, reviewerId: string, edits: ReviewEdits): Promise<ApproveResult> {
  return inTransaction(async (tx) => {
    await pgAdvisoryXactLock(tx, RULE_NAME_LOCK_KEY);
    await pgAdvisoryXactLock(tx, LIBRARY_REQUEST_LOCK_KEY);
    const row = await one(tx.select().from(libraryRequests).where(eq(libraryRequests.id, id)));
    if (!row) return { ok: false, reason: 'not-found' };
    if (row.status !== 'open') return { ok: false, reason: 'not-open' };

    const definition = applyReviewEdits(parseDefinition(row.definition), edits);
    let rule: Rule;
    let before: Rule | undefined;
    if (row.targetRuleId) {
      const target = await loadRuleWithDefinition(row.targetRuleId, tx);
      if (!target) return { ok: false, reason: 'target-gone' };
      if (target.rule.type !== 'custom') return { ok: false, reason: 'not-custom' };
      if (target.rule.queryBackend !== definition.queryBackend) return { ok: false, reason: 'backend-mismatch' };
      const updated = await updateRuleOn(tx, target.rule.id, changesFrom(definition, edits.enabled));
      if (!updated.ok) return updated.reason === 'not-found' ? { ok: false, reason: 'target-gone' } : updated;
      rule = updated.rule;
      before = target.rule;
    } else {
      const inserted = await insertRuleOn(tx, libraryRuleFrom(definition, edits.enabled ?? false, row.id));
      if (!inserted.ok) return inserted;
      rule = inserted.rule;
    }

    await run(tx.update(libraryRequests).set({
      status: 'approved', reviewedBy: reviewerId, reviewedAt: new Date().toISOString(), libraryRuleId: rule.id,
    }).where(eq(libraryRequests.id, id)));
    if (row.personalRuleId) await setPersonalRuleLibraryRule(row.personalRuleId, row.authorId, rule.id, tx);

    return { ok: true, rule, before, request: rowToRequest((await one(tx.select().from(libraryRequests).where(eq(libraryRequests.id, id))))!) };
  });
}

export type CloseResult =
  | { ok: true; request: LibraryRequest }
  | { ok: false; reason: 'not-found' | 'not-open' };

async function closeOpenRequest(
  id: string, authorId: string | undefined, changes: Partial<typeof libraryRequests.$inferInsert>,
): Promise<CloseResult> {
  return inTransaction(async (tx) => {
    await pgAdvisoryXactLock(tx, LIBRARY_REQUEST_LOCK_KEY);
    const row = await one(tx.select().from(libraryRequests)
      .where(authorId === undefined ? eq(libraryRequests.id, id) : and(eq(libraryRequests.id, id), eq(libraryRequests.authorId, authorId))));
    if (!row) return { ok: false, reason: 'not-found' };
    if (row.status !== 'open') return { ok: false, reason: 'not-open' };
    await run(tx.update(libraryRequests).set(changes).where(eq(libraryRequests.id, id)));
    return { ok: true, request: rowToRequest((await one(tx.select().from(libraryRequests).where(eq(libraryRequests.id, id))))!) };
  });
}

/** Closes an open request with the reviewer's reason. The reason is stored and shown to the author, and never audited. */
export function rejectLibraryRequest(id: string, reviewerId: string, reason: string): Promise<CloseResult> {
  return closeOpenRequest(id, undefined, {
    status: 'rejected', reviewedBy: reviewerId, reviewedAt: new Date().toISOString(), rejectionReason: reason.trim(),
  });
}

/** The author takes back their own open request. */
export function withdrawLibraryRequest(id: string, authorId: string): Promise<CloseResult> {
  return closeOpenRequest(id, authorId, { status: 'withdrawn' });
}

export type CopyToLibraryResult =
  | { ok: true; rule: Rule }
  | { ok: false; reason: 'name-taken' }
  | { ok: false; reason: 'in-library'; libraryRuleName: string };

/**
 * A reviewer copies their own Personal rule straight into the library, with no request. The rule gets a
 * new id and no request id, starts disabled, and the Personal rule is pointed at it. One transaction,
 * the name checked under the same lock as `createRule()`. A Personal rule already in the library (a copy
 * or an approved request made a rule that still exists) is refused, read again under the lock, so two
 * clicks cannot add it twice.
 */
export async function copyPersonalRuleToLibrary(rule: PersonalRule): Promise<CopyToLibraryResult> {
  return inTransaction(async (tx) => {
    await pgAdvisoryXactLock(tx, RULE_NAME_LOCK_KEY);
    const current = await getPersonalRule(rule.id, rule.ownerId, tx);
    const existing = current?.libraryRuleId ? await loadRuleWithDefinition(current.libraryRuleId, tx) : null;
    if (existing) return { ok: false, reason: 'in-library', libraryRuleName: existing.rule.name };
    const inserted = await insertRuleOn(tx, libraryRuleFrom(definitionOfPersonalRule(rule), false));
    if (!inserted.ok) return inserted;
    await setPersonalRuleLibraryRule(rule.id, rule.ownerId, inserted.rule.id, tx);
    return { ok: true, rule: inserted.rule };
  });
}
