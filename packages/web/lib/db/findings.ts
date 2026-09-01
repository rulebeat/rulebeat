import { eq, and, inArray, sql } from 'drizzle-orm';
import { db } from './client';
import { findings as findingsTable, findingEvents as findingEventsTable } from './tables';
import { many, run, inTransaction } from './exec';
import { loadScanHistory } from '../scan-history';
import { loadRules } from '../rules';
import { listCategories } from './categories';
import { upsertDailySnapshot } from './snapshots';
import { getMeta, setMeta } from './meta';
import type { Finding, Severity } from '../types';

export interface FindingRecord extends Finding {
  status: 'active' | 'fixed';
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt?: string;
  timesSeen: number;
}

export interface SyncResult {
  created: string[];
  reactivated: string[];
  resolved: string[];
}

export interface SyncScanFindingsOptions {
  scanId: string;
  category: string;
  /** Enabled/targeted rule ids that actually ran this scan — used to scope the resolve step
   *  so disabled rules or tag/rule-scoped schedules never falsely resolve findings outside
   *  what they actually checked. */
  ranRuleIds: string[];
  findings: Finding[];
  finishedAt: string;
  /** Skips finding_events rows — used by the history backfill so replaying old scans doesn't
   *  fabricate a created→resolved audit trail for transitions nobody actually observed live. */
  silent?: boolean;
}

const CHUNK_SIZE = 500; // SQLite's default 999-variable-per-statement limit
const EVENT_RETENTION_DAYS = 180;
const BACKFILL_MARKER = 'findings-backfilled-v1';

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Collapses a scan's findings to one row per fingerprint before anything counts, saves, or
 *  classifies them — a rule whose ARG query returns the same resource twice in one page (e.g. a
 *  fan-out join) must still count as one sighting, not two. Last occurrence wins: there's no
 *  ordering signal in ARG's response that would justify preferring the first. */
export function dedupeFindingsByFingerprint(findings: Finding[]): Finding[] {
  const byFingerprint = new Map<string, Finding>();
  for (const f of findings) byFingerprint.set(f.fingerprint, f);
  return Array.from(byFingerprint.values());
}

type Row = typeof findingsTable.$inferSelect;

function rowToRecord(row: Row): FindingRecord {
  return {
    module: row.category,
    ruleId: row.ruleId,
    fingerprint: row.fingerprint,
    severity: row.severity as Severity,
    category: row.category,
    kind: row.kind as 'state' | 'activity',
    dimensionKey: row.dimensionKey ?? undefined,
    resourceId: row.resourceId ?? undefined,
    resourceType: row.resourceType ?? undefined,
    resourceName: row.resourceName ?? undefined,
    subscriptionId: row.subscriptionId,
    resourceGroup: row.resourceGroup ?? undefined,
    location: row.location ?? undefined,
    title: row.title,
    description: row.description,
    evidence: JSON.parse(row.evidence) as Record<string, unknown>,
    recommendation: row.recommendation,
    remediationSteps: JSON.parse(row.remediationSteps) as Finding['remediationSteps'],
    azurePortalLink: row.azurePortalLink ?? undefined,
    detectedAt: row.firstSeenAt,
    status: row.status as 'active' | 'fixed',
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    resolvedAt: row.resolvedAt ?? undefined,
    timesSeen: row.timesSeen,
  };
}

/** Resolves fingerprints back to their finding rows regardless of current status (active or fixed) —
 *  a since-fixed finding was still real and new when a run first detected it, and notifying about it
 *  after the fact remains correct (spec 025). Fingerprints with no row (the rule was hard-deleted via
 *  deleteFindingsForRule()) are silently omitted, not errored. */
export async function getFindingsByFingerprints(fingerprints: string[]): Promise<FindingRecord[]> {
  if (fingerprints.length === 0) return [];
  const out: FindingRecord[] = [];
  for (const fpChunk of chunk(fingerprints, CHUNK_SIZE)) {
    const rows = await many(db.select().from(findingsTable).where(inArray(findingsTable.fingerprint, fpChunk)));
    out.push(...rows.map(rowToRecord));
  }
  return out;
}

export async function listFindings(opts: { status?: 'active' | 'fixed' } = {}): Promise<FindingRecord[]> {
  const rows = opts.status
    ? await many(db.select().from(findingsTable).where(eq(findingsTable.status, opts.status)))
    : await many(db.select().from(findingsTable));
  return rows.map(rowToRecord);
}

export async function syncScanFindings(opts: SyncScanFindingsOptions): Promise<SyncResult> {
  const { scanId, category, ranRuleIds, findings: rawFindings, finishedAt, silent } = opts;
  const findings = dedupeFindingsByFingerprint(rawFindings);
  const created: string[] = [];
  const reactivated: string[] = [];
  const resolved: string[] = [];
  // An 'activity' finding never resolves (step 3 below excludes kind:'state'), so a repeat
  // occurrence is neither 'created' nor 'reactivated' — it needs its own event type (step 4) so
  // the activity-occurrences widget still gets one data point per scan that reported it.
  const occurred: string[] = [];

  await inTransaction(async (tx) => {
    const seenFingerprints = findings.map(f => f.fingerprint);
    const seenSet = new Set(seenFingerprints);
    const resolvedRuleByFp = new Map<string, string>();

    // 1. Classify: not present = created; present but currently fixed = reactivated; present,
    // already active, and kind:'activity' = occurred (a repeat 'state' sighting gets no event).
    const existingByFp = new Map<string, Row>();
    for (const fpChunk of chunk(seenFingerprints, CHUNK_SIZE)) {
      if (fpChunk.length === 0) continue;
      const rows = await many(tx.select().from(findingsTable).where(inArray(findingsTable.fingerprint, fpChunk)));
      for (const r of rows) existingByFp.set(r.fingerprint, r);
    }
    for (const f of findings) {
      const existing = existingByFp.get(f.fingerprint);
      if (!existing) created.push(f.fingerprint);
      else if (existing.status === 'fixed') reactivated.push(f.fingerprint);
      else if (f.kind === 'activity') occurred.push(f.fingerprint);
    }

    // 2. Upsert every finding from this scan as active, refreshing denormalized display fields.
    for (const f of findings) {
      await run(tx.insert(findingsTable).values({
        fingerprint: f.fingerprint,
        ruleId: f.ruleId,
        category,
        severity: f.severity,
        // kind/dimensionKey are baked into the fingerprint's own hash (computeFingerprint vs.
        // computeActivityFingerprint), so — like resourceId below — they're set once at insert
        // and deliberately excluded from the conflict-update set: they can't legitimately change
        // for a fingerprint that already exists.
        kind: f.kind ?? 'state',
        dimensionKey: f.dimensionKey ?? null,
        resourceId: f.resourceId ?? null,
        resourceType: f.resourceType ?? null,
        resourceName: f.resourceName ?? null,
        subscriptionId: f.subscriptionId,
        resourceGroup: f.resourceGroup ?? null,
        location: f.location ?? null,
        title: f.title,
        description: f.description,
        recommendation: f.recommendation,
        remediationSteps: JSON.stringify(f.remediationSteps ?? []),
        evidence: JSON.stringify(f.evidence ?? {}),
        azurePortalLink: f.azurePortalLink ?? null,
        status: 'active',
        firstSeenAt: finishedAt,
        lastSeenAt: finishedAt,
        resolvedAt: null,
        lastScanId: scanId,
        timesSeen: 1,
      }).onConflictDoUpdate({
        target: findingsTable.fingerprint,
        set: {
          ruleId: f.ruleId,
          category,
          severity: f.severity,
          resourceType: f.resourceType ?? null,
          resourceName: f.resourceName ?? null,
          subscriptionId: f.subscriptionId,
          resourceGroup: f.resourceGroup ?? null,
          location: f.location ?? null,
          title: f.title,
          description: f.description,
          recommendation: f.recommendation,
          remediationSteps: JSON.stringify(f.remediationSteps ?? []),
          evidence: JSON.stringify(f.evidence ?? {}),
          azurePortalLink: f.azurePortalLink ?? null,
          status: 'active',
          lastSeenAt: finishedAt,
          resolvedAt: null,
          lastScanId: scanId,
          timesSeen: sql`${findingsTable.timesSeen} + 1`,
        },
      }));
    }

    // 3. Resolve: findings that were active for a rule this scan actually ran, but didn't
    // reappear. Scoping to (category, ranRuleIds) means disabled rules and tag/rule-scoped
    // schedules never falsely resolve findings outside what they checked. kind:'state' excludes
    // 'activity' findings — those never resolve, they age out of a read-time window instead
    // (spec 034): a rule not re-reporting an occurrence this scan says nothing about whether it's
    // still relevant, unlike a resource genuinely no longer matching a state rule's query.
    for (const ruleChunk of chunk(ranRuleIds, CHUNK_SIZE)) {
      if (ruleChunk.length === 0) continue;
      const staleActive = await many(
        tx.select({ fingerprint: findingsTable.fingerprint, ruleId: findingsTable.ruleId })
          .from(findingsTable)
          .where(and(
            eq(findingsTable.category, category),
            inArray(findingsTable.ruleId, ruleChunk),
            eq(findingsTable.status, 'active'),
            eq(findingsTable.kind, 'state'),
          )),
      );
      const toResolve = staleActive.filter(r => !seenSet.has(r.fingerprint));
      for (const r of toResolve) resolvedRuleByFp.set(r.fingerprint, r.ruleId);
      for (const resolveChunk of chunk(toResolve, CHUNK_SIZE)) {
        if (resolveChunk.length === 0) continue;
        await run(
          tx.update(findingsTable).set({ status: 'fixed', resolvedAt: finishedAt })
            .where(inArray(findingsTable.fingerprint, resolveChunk.map(r => r.fingerprint))),
        );
        resolved.push(...resolveChunk.map(r => r.fingerprint));
      }
    }

    // 4. Events (skipped for silent/backfill syncs — no live transition was actually observed).
    if (!silent) {
      // `finishedAt`, not `new Date()`: an event records when the scan *observed* the transition,
      // which is the scan's own finish time, not whatever instant this line of code happens to
      // execute. They differ by milliseconds live, but a demo/backfill replay can pass a
      // `finishedAt` from days in the past — stamping "now" there would put every event at the
      // instant the generator ran instead of its simulated date, collapsing the whole trend.
      const findingByFp = new Map(findings.map(f => [f.fingerprint, f]));
      const events: (typeof findingEventsTable.$inferInsert)[] = [];
      for (const fp of created) {
        const f = findingByFp.get(fp)!;
        events.push({ id: crypto.randomUUID(), fingerprint: fp, ruleId: f.ruleId, category, scanId, type: 'created', occurredAt: finishedAt });
      }
      for (const fp of reactivated) {
        const f = findingByFp.get(fp)!;
        events.push({ id: crypto.randomUUID(), fingerprint: fp, ruleId: f.ruleId, category, scanId, type: 'reactivated', occurredAt: finishedAt });
      }
      for (const fp of occurred) {
        const f = findingByFp.get(fp)!;
        events.push({ id: crypto.randomUUID(), fingerprint: fp, ruleId: f.ruleId, category, scanId, type: 'occurred', occurredAt: finishedAt });
      }
      for (const fp of resolved) {
        const ruleId = resolvedRuleByFp.get(fp) ?? '';
        events.push({ id: crypto.randomUUID(), fingerprint: fp, ruleId, category, scanId, type: 'resolved', occurredAt: finishedAt });
      }
      if (events.length > 0) {
        for (const evChunk of chunk(events, CHUNK_SIZE)) {
          await run(tx.insert(findingEventsTable).values(evChunk));
        }
      }

      const cutoff = new Date(Date.now() - EVENT_RETENTION_DAYS * 86_400_000).toISOString();
      await run(tx.delete(findingEventsTable).where(sql`${findingEventsTable.occurredAt} < ${cutoff}`));
    }
  });

  return { created, reactivated, resolved };
}

export interface FindingEventCount { date: string; created: number; resolved: number; }

/** Daily created(+reactivated)-vs-resolved counts from finding_events, for the "New vs Fixed"
 *  remediation-velocity widget. Events only carry fingerprint/ruleId/category, but the findings
 *  row (same fingerprint, deleted together with its events in deleteFindingsForRule) carries
 *  subscription/RG/severity — a join covers those dimensions, so every filter the other widgets
 *  support works here too. Tag filters are resolved to rule ids by the caller (rules own tags).
 *  Caveat: the join reads the finding's *current* subscription/RG/severity, not event-time
 *  values — same convention as every live findings-sourced number. Days with no events are
 *  zero-filled between the first event and today so bar spacing stays honest. */
export async function getFindingEventCounts(opts: {
  categories?: string[];
  ruleIds?: string[];
  subscriptions?: string[];
  resourceGroups?: string[];
  severities?: string[];
  sinceDate: string;
}): Promise<FindingEventCount[]> {
  const conditions = [sql`${findingEventsTable.occurredAt} >= ${opts.sinceDate}`];
  if (opts.categories?.length) conditions.push(inArray(findingEventsTable.category, opts.categories));
  if (opts.ruleIds?.length) conditions.push(inArray(findingEventsTable.ruleId, opts.ruleIds));

  const needsJoin = Boolean(opts.subscriptions?.length || opts.resourceGroups?.length || opts.severities?.length);
  if (opts.subscriptions?.length) conditions.push(inArray(findingsTable.subscriptionId, opts.subscriptions));
  if (opts.resourceGroups?.length) conditions.push(inArray(findingsTable.resourceGroup, opts.resourceGroups));
  if (opts.severities?.length) conditions.push(inArray(findingsTable.severity, opts.severities));

  const selection = { type: findingEventsTable.type, occurredAt: findingEventsTable.occurredAt };
  const rows = needsJoin
    ? await many(db.select(selection).from(findingEventsTable)
        .innerJoin(findingsTable, eq(findingEventsTable.fingerprint, findingsTable.fingerprint))
        .where(and(...conditions)))
    : await many(db.select(selection).from(findingEventsTable)
        .where(and(...conditions)));

  const byDate = new Map<string, { created: number; resolved: number }>();
  for (const r of rows) {
    const date = r.occurredAt.slice(0, 10);
    const entry = byDate.get(date) ?? { created: 0, resolved: 0 };
    if (r.type === 'created' || r.type === 'reactivated') entry.created++;
    else if (r.type === 'resolved') entry.resolved++;
    byDate.set(date, entry);
  }
  if (byDate.size === 0) return [];

  // Zero-fill from the first event day through today — a categorical bar axis otherwise packs
  // sparse days next to each other, making activity look denser than it was.
  const firstDate = Array.from(byDate.keys()).sort()[0];
  const today = new Date().toISOString().slice(0, 10);
  const out: FindingEventCount[] = [];
  for (let d = new Date(`${firstDate}T00:00:00Z`); d.toISOString().slice(0, 10) <= today; d.setUTCDate(d.getUTCDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    const e = byDate.get(date) ?? { created: 0, resolved: 0 };
    out.push({ date, ...e });
  }
  return out;
}

export interface ActivityOccurrenceCount { date: string; count: number; }

/** Daily occurrence counts for kind:'activity' findings, from finding_events — data source for
 *  the Activity Occurrences widget (spec 034). Unlike getFindingEventCounts(), the join to
 *  findings is unconditional rather than opt-in: 'created' events are shared with kind:'state'
 *  findings (both kinds get one on first sighting), so kind must always be checked to keep the
 *  two apart — 'occurred' events are activity-only by construction (syncScanFindings() step 4),
 *  but 'created' events are not. Same zero-fill-from-first-event-to-today convention. */
export async function getActivityOccurrenceCounts(opts: {
  categories?: string[];
  ruleIds?: string[];
  subscriptions?: string[];
  resourceGroups?: string[];
  severities?: string[];
  sinceDate: string;
}): Promise<ActivityOccurrenceCount[]> {
  const conditions = [
    sql`${findingEventsTable.occurredAt} >= ${opts.sinceDate}`,
    inArray(findingEventsTable.type, ['created', 'occurred']),
    eq(findingsTable.kind, 'activity'),
  ];
  if (opts.categories?.length) conditions.push(inArray(findingEventsTable.category, opts.categories));
  if (opts.ruleIds?.length) conditions.push(inArray(findingEventsTable.ruleId, opts.ruleIds));
  if (opts.subscriptions?.length) conditions.push(inArray(findingsTable.subscriptionId, opts.subscriptions));
  if (opts.resourceGroups?.length) conditions.push(inArray(findingsTable.resourceGroup, opts.resourceGroups));
  if (opts.severities?.length) conditions.push(inArray(findingsTable.severity, opts.severities));

  const rows = await many(
    db.select({ occurredAt: findingEventsTable.occurredAt })
      .from(findingEventsTable)
      .innerJoin(findingsTable, eq(findingEventsTable.fingerprint, findingsTable.fingerprint))
      .where(and(...conditions)),
  );

  const byDate = new Map<string, number>();
  for (const r of rows) {
    const date = r.occurredAt.slice(0, 10);
    byDate.set(date, (byDate.get(date) ?? 0) + 1);
  }
  if (byDate.size === 0) return [];

  const firstDate = Array.from(byDate.keys()).sort()[0];
  const today = new Date().toISOString().slice(0, 10);
  const out: ActivityOccurrenceCount[] = [];
  for (let d = new Date(`${firstDate}T00:00:00Z`); d.toISOString().slice(0, 10) <= today; d.setUTCDate(d.getUTCDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    out.push({ date, count: byDate.get(date) ?? 0 });
  }
  return out;
}

export async function deleteFindingsForRule(ruleId: string): Promise<void> {
  const categoryRows = await many(
    db.select({ category: findingsTable.category }).from(findingsTable)
      .where(eq(findingsTable.ruleId, ruleId)),
  );
  const affectedCategories = new Set(categoryRows.map(r => r.category));

  await inTransaction(async (tx) => {
    await run(tx.delete(findingEventsTable).where(eq(findingEventsTable.ruleId, ruleId)));
    await run(tx.delete(findingsTable).where(eq(findingsTable.ruleId, ruleId)));
  });

  for (const category of affectedCategories) await upsertDailySnapshot(category);
}

// --- one-time backfill from existing scan history (blob-based, best-effort mid-history) ---

/**
 * Fills in anything a historical scan record is missing before it becomes a findings row.
 *
 * Scan history is a JSON blob written by whichever version was running at the time, so an old one can
 * predate fields that are now NOT NULL. Handing it straight to the insert throws — and this runs from
 * `instrumentation.ts` at startup, so an upgrade could fail to boot over a single old record.
 *
 * Identity is the one thing that cannot be invented: without a rule and a resource there is no
 * finding, so those records are skipped. Everything else falls back to something honest and the
 * history is kept, which is the entire point of the backfill.
 */
function restoreHistoricFinding(raw: Partial<Finding>, category: string): Finding | null {
  if (!raw.ruleId || !raw.resourceId) return null;

  const subscriptionFromId = raw.resourceId.match(/\/subscriptions\/([^/]+)/i)?.[1];
  return {
    ...raw,
    ruleId: raw.ruleId,
    resourceId: raw.resourceId,
    category: raw.category ?? (category as Finding['category']),
    severity: raw.severity ?? 'medium',
    resourceType: raw.resourceType ?? '',
    resourceName: raw.resourceName ?? raw.resourceId.split('/').pop() ?? raw.resourceId,
    subscriptionId: raw.subscriptionId ?? subscriptionFromId ?? '',
    title: raw.title ?? raw.ruleId,
    description: raw.description ?? '',
    recommendation: raw.recommendation ?? '',
    evidence: raw.evidence ?? {},
  } as Finding;
}

export async function backfillFindings(): Promise<void> {
  if (await getMeta(BACKFILL_MARKER)) return;

  const categories = await listCategories();
  const allRules = await loadRules();
  const enabledIdsByCategory = new Map<string, string[]>();
  for (const r of allRules) {
    if (!r.enabled) continue;
    const list = enabledIdsByCategory.get(r.category);
    if (list) list.push(r.id); else enabledIdsByCategory.set(r.category, [r.id]);
  }

  for (const category of categories) {
    // Per category, so one unreadable slice of history cannot cost the user every other category's.
    try {
      const history = await loadScanHistory(category.id); // newest-first
      if (history.length === 0) continue;
      const oldestFirst = [...history].reverse();
      const restore = (scan: { findings: Finding[] }) => scan.findings
        .map(f => restoreHistoricFinding(f, category.id))
        .filter((f): f is Finding => f !== null);

      for (let i = 0; i < oldestFirst.length; i++) {
        const scan = oldestFirst[i];
        const isLast = i === oldestFirst.length - 1;
        const findings = restore(scan);
        const ranRuleIds = Array.from(new Set(findings.map(f => f.ruleId)));
        await syncScanFindings({
          scanId: crypto.randomUUID(),
          category: category.id,
          ranRuleIds,
          findings,
          finishedAt: scan.finishedAt,
          // Mid-history transitions are fabricated (never actually observed live) and stay
          // silent; only the most recent scan's transition reflects real current state, so it
          // gets a real event trail to seed alerting/audit history going forward.
          silent: !isLast,
        });
      }

      // Final reconciliation: resolve against the currently-enabled rule set (not just what
      // last appeared in the blob) so rules disabled/removed since don't linger as false-active.
      const latest = oldestFirst[oldestFirst.length - 1];
      const currentRuleIds = enabledIdsByCategory.get(category.id) ?? [];
      await syncScanFindings({
        scanId: crypto.randomUUID(),
        category: category.id,
        ranRuleIds: currentRuleIds,
        findings: restore(latest),
        finishedAt: latest.finishedAt,
        silent: true,
      });
    } catch (err) {
      // Reported rather than swallowed: this is history reconstruction, so degrading is acceptable,
      // but it must be visible in the server log rather than looking like the category simply had
      // nothing in it.
      console.error(`[backfill] could not rebuild finding history for '${category.id}':`, err);
    }
  }

  await setMeta(BACKFILL_MARKER, '1');
}
