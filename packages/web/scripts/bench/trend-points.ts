/**
 * The benchmark behind `npm run bench:trend-points` (ADR 0013): what it costs to refresh today's trend
 * points on every posture input, and what a dashboard read costs on top of them, at 2,000 subscriptions,
 * 30 categories and 50,000 findings. It times, on whichever backend the process has open:
 *
 *  - one refresh of every category, the first of the day (most subscription points are unchanged and not
 *    written) and a repeat (every level already has today's point, so every level is rewritten);
 *  - the transaction hold per category, taken as one category refreshed on its own, its median and its longest;
 *  - `computeWidgetSummary` for Everything and for a person who holds a slice of the estate;
 *  - the last-scanned read, `listLastScanTimes`, for the same two people.
 *
 * Two halves, both importable so a test can run them at a tiny size:
 *  - `generateDataset()` is pure. The same seed always gives the same tree, rules, findings and suppressions.
 *  - `runBench()` stores that dataset (findings through the real scan sync, history through the real queued
 *    writer) and runs the named measurements.
 *
 * It uses whichever database the process has open and never opens one itself, so the CLI wrapper
 * (`scripts/bench-trend-points.ts`) points a fresh temp file, or the Postgres database it was given, at the
 * process first and a test uses its own. Every repository import here is dynamic for the same reason as in
 * `bench/finding-views.ts`.
 */

import os from 'node:os';
import { buildAccess, everythingAccess, type Access } from '../../lib/access-model';

/** The spec's limit: a refresh or a read that takes longer sends the spec back for a decision. */
export const THRESHOLD_MS = 1000;

/** The bench measures the reads themselves, so the main reader is Everything. */
const BENCH_ACCESS = everythingAccess('admin');

const TENANT = '00000000-0000-0000-0000-0000000000b0';
const DAY_MS = 86_400_000;

// ---- The dataset ----

export interface DatasetOptions {
  subscriptions: number;
  categories: number;
  findings: number;
  rulesPerCategory: number;
  seed: number;
}

export interface PlannedNode { kind: 'managementGroup' | 'subscription'; id: string; name: string; parentId: string }

export interface PlannedRule {
  id: string;
  /** The index of the category (0 to categories - 1) the rule sits in. */
  category: number;
  severity: 'critical' | 'high' | 'medium' | 'low';
  /** Unscoped, a list of subscriptions, a management group, or a Microsoft Graph rule (the Directory). */
  scope: 'all' | 'list' | 'group' | 'directory';
  subscriptions: string[];
  managementGroup: string | null;
  lastRunStatus: 'success' | 'failed';
}

export interface PlannedFinding {
  index: number;
  ruleId: string;
  category: number;
  severity: PlannedRule['severity'];
  /** '' for a finding in the Directory. */
  subscriptionId: string;
  placement: 'resource' | 'directory' | 'management-group';
  managementGroupId?: string;
  suppressed: boolean;
}

export interface Dataset {
  subscriptions: string[];
  managementGroups: string[];
  nodes: PlannedNode[];
  rules: PlannedRule[];
  findings: PlannedFinding[];
}

/** A small seeded generator, so the same seed always gives the same data. */
export function seededRandom(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (n: number, width: number): string => n.toString(16).padStart(width, '0');
export const subscriptionIdOf = (n: number): string => `${hex(n + 1, 8)}-0000-4000-8000-${hex(n + 1, 12)}`;
export const categoryIdOf = (n: number): string => `bench-category-${String(n + 1).padStart(2, '0')}`;

export function generateDataset(opts: DatasetOptions): Dataset {
  const random = seededRandom(opts.seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;

  const subscriptions = Array.from({ length: opts.subscriptions }, (_, n) => subscriptionIdOf(n));
  // About fifty subscriptions to a group, in two levels: a few top groups, each holding the rest.
  const groupCount = Math.max(2, Math.ceil(opts.subscriptions / 50));
  const managementGroups = Array.from({ length: groupCount }, (_, n) => `bench-group-${String(n + 1).padStart(3, '0')}`);
  const nodes: PlannedNode[] = [{ kind: 'managementGroup', id: TENANT, name: 'Tenant Root Group', parentId: '' }];
  managementGroups.forEach((id, n) => {
    nodes.push({ kind: 'managementGroup', id, name: `Group ${n + 1}`, parentId: n < 4 ? TENANT : managementGroups[n % 4]! });
  });
  subscriptions.forEach((id, n) => nodes.push({ kind: 'subscription', id, name: `Subscription ${n + 1}`, parentId: managementGroups[n % groupCount]! }));

  const severities = ['critical', 'high', 'medium', 'low'] as const;
  const rules: PlannedRule[] = [];
  for (let category = 0; category < opts.categories; category += 1) {
    for (let n = 0; n < opts.rulesPerCategory; n += 1) {
      const roll = random();
      const scope: PlannedRule['scope'] = roll < 0.4 ? 'all' : roll < 0.7 ? 'list' : roll < 0.95 ? 'group' : 'directory';
      const listed = scope === 'list'
        ? Array.from({ length: 5 + Math.floor(random() * 46) }, () => pick(subscriptions))
        : [];
      rules.push({
        id: `bench-rule-${String(category + 1).padStart(2, '0')}-${String(n + 1).padStart(2, '0')}`,
        category,
        severity: pick(severities),
        scope,
        subscriptions: [...new Set(listed)],
        managementGroup: scope === 'group' ? pick(managementGroups) : null,
        lastRunStatus: random() < 0.9 ? 'success' : 'failed',
      });
    }
  }

  const findings: PlannedFinding[] = [];
  for (let index = 0; index < opts.findings; index += 1) {
    const rule = pick(rules);
    const roll = random();
    const directory = rule.scope === 'directory';
    const atGroup = !directory && roll < 0.01;
    findings.push({
      index,
      ruleId: rule.id,
      category: rule.category,
      severity: rule.severity,
      subscriptionId: directory || atGroup ? '' : pick(subscriptions),
      placement: directory ? 'directory' : atGroup ? 'management-group' : 'resource',
      ...(atGroup ? { managementGroupId: pick(managementGroups) } : {}),
      suppressed: random() < 0.02,
    });
  }
  return { subscriptions, managementGroups, nodes, rules, findings };
}

// ---- Storing it ----

/** Everything the measurements need to know about what was stored. */
export interface Seeded {
  categoryIds: string[];
  /** The subscriptions the scoped reader holds, whole. */
  heldSubscriptions: string[];
}

const nameOf = (finding: PlannedFinding): string => `bench-resource-${finding.index}`;

/** Stores the dataset: categories, rules, the tree, findings through the real scan sync, suppressions and
 *  scan history; then two days of trend history through the real writer, so a refresh today has earlier
 *  points to compare with. Leaves no point for today. */
export async function seedDatabase(dataset: Dataset, opts: DatasetOptions, log: (line: string) => void = () => {}): Promise<Seeded> {
  const { computeFingerprint } = await import('@rulebeat/core');
  const { db } = await import('../../lib/db/client');
  const { run } = await import('../../lib/db/exec');
  const { rules, categories, suppressions, scans, postureSnapshots } = await import('../../lib/db/tables');
  const { listCategories } = await import('../../lib/db/categories');
  const { replaceHierarchy } = await import('../../lib/db/management-group-hierarchy');
  const { syncScanFindingsDetailed } = await import('../../lib/db/findings');
  const { refreshSnapshotsFor } = await import('../../lib/db/snapshots');
  const { serializeCoveredScope } = await import('../../lib/covered-scope-view');
  const { EMPTY_SCAN_BLOB } = await import('../../lib/db/scan-findings-copy');
  const { EVERYTHING_TENANT_ID } = await import('../../lib/access-model');
  const { eq } = await import('drizzle-orm');

  const start = performance.now();
  const now = Date.now();
  const timed = (label: string, from: number): void => log(`${label}: ${Math.round(performance.now() - from)} ms`);

  // Categories: the ones the install has, then new ones up to the count asked for.
  const existing = (await listCategories()).map(c => c.id);
  const categoryIds: string[] = [];
  for (let n = 0; n < opts.categories; n += 1) {
    const id = existing[n] ?? categoryIdOf(n);
    categoryIds.push(id);
    if (existing[n] === undefined) {
      await run(db.insert(categories).values({
        id, label: `Bench category ${n + 1}`, color: null, icon: null, sortOrder: 1000 + n, isBuiltin: false, createdAt: new Date(now).toISOString(),
      }));
    }
  }

  for (const rule of dataset.rules) {
    await run(db.delete(rules).where(eq(rules.id, rule.id)));
    const graph = rule.scope === 'directory';
    await run(db.insert(rules).values({
      id: rule.id,
      name: `Bench rule ${rule.id}`,
      description: 'bench rule',
      category: categoryIds[rule.category]!,
      severity: rule.severity,
      enabled: true,
      scope: JSON.stringify({
        level: 'subscription',
        ...(rule.scope === 'list' ? { subscriptions: rule.subscriptions } : {}),
        ...(rule.managementGroup ? { managementGroups: [rule.managementGroup] } : {}),
      }),
      resourceTypes: '[]',
      conditions: '[]',
      rawKql: graph ? null : 'resources | project id',
      graphQuery: graph ? JSON.stringify({ endpoint: 'applications', select: ['id'] }) : null,
      queryBackend: graph ? 'microsoft-graph' : 'resource-graph',
      kind: 'state',
      type: 'custom',
      lastRunStatus: rule.lastRunStatus,
      lastRunAt: new Date(now - DAY_MS).toISOString(),
    }));
  }

  await replaceHierarchy(dataset.nodes.map(n => ({
    tenantId: TENANT, kind: n.kind, id: n.id, name: n.name, parentId: n.parentId === '' ? null : n.parentId,
  })), new Date(now).toISOString());

  // Findings: one scan per category, through the real sync (which does not refresh: the bench does that below).
  const ruleById = new Map(dataset.rules.map(r => [r.id, r]));
  const fingerprints: { fingerprint: string; resourceId: string | undefined }[] = [];
  const syncStart = performance.now();
  for (let category = 0; category < opts.categories; category += 1) {
    const planned = dataset.findings.filter(f => f.category === category);
    const findings = planned.map(f => {
      const resourceId = f.placement === 'directory' ? `applications/${nameOf(f)}`
        : f.placement === 'management-group' ? `/providers/Microsoft.Management/managementGroups/${f.managementGroupId}/${nameOf(f)}`
        : `/subscriptions/${f.subscriptionId}/resourceGroups/rg-${f.index % 7}/providers/Microsoft.Compute/virtualMachines/${nameOf(f)}`;
      const fingerprint = computeFingerprint(f.ruleId, resourceId);
      if (f.suppressed) fingerprints.push({ fingerprint, resourceId });
      return {
        module: categoryIds[category]!,
        ruleId: f.ruleId,
        fingerprint,
        severity: ruleById.get(f.ruleId)!.severity,
        category: categoryIds[category]!,
        resourceId,
        resourceType: f.placement === 'directory' ? 'microsoft.graph/applications' : 'microsoft.compute/virtualmachines',
        resourceName: nameOf(f),
        subscriptionId: f.subscriptionId,
        resourceGroup: f.placement === 'resource' ? `rg-${f.index % 7}` : undefined,
        placement: f.placement,
        ...(f.managementGroupId ? { managementGroupId: f.managementGroupId } : {}),
        title: `Finding of ${f.ruleId}`,
        description: 'bench finding',
        evidence: {},
        rows: [],
        recommendation: 'fix it',
        remediationSteps: [],
        detectedAt: new Date(now - 3 * DAY_MS).toISOString(),
      };
    });
    await syncScanFindingsDetailed({
      scanId: crypto.randomUUID(),
      category: categoryIds[category]!,
      ranRuleIds: dataset.rules.filter(r => r.category === category).map(r => r.id),
      findings,
      finishedAt: new Date(now - 3 * DAY_MS).toISOString(),
    });
  }
  timed('findings stored', syncStart);

  const suppressedAt = new Date(now - 2 * DAY_MS).toISOString();
  for (let i = 0; i < fingerprints.length; i += 500) {
    await run(db.insert(suppressions).values(fingerprints.slice(i, i + 500).map((f, n) => ({
      id: `bench-suppression-${i + n}`, fingerprint: f.fingerprint, resourceId: f.resourceId ?? null, reason: 'Accepted', suppressedAt, expiresAt: null,
    }))));
  }

  // Scan history: 20 scans a category, a third of them narrowed to a few subscriptions, so the last-scanned
  // read of a person who holds a slice has to search back past scans that do not overlap.
  const heldSubscriptions = dataset.subscriptions.slice(0, Math.min(20, dataset.subscriptions.length));
  const narrowed = JSON.stringify([{ tenantId: TENANT, path: `/subscriptions/${dataset.subscriptions[dataset.subscriptions.length - 1]}` }]);
  for (let category = 0; category < opts.categories; category += 1) {
    const rows = Array.from({ length: 20 }, (_, n) => {
      const finished = new Date(now - (n + 1) * 3_600_000).toISOString();
      return {
        id: crypto.randomUUID(), module: categoryIds[category]!, startedAt: finished, finishedAt: finished, durationMs: 1000,
        subscriptionsScanned: '[]', findings: EMPTY_SCAN_BLOB, counts: '{}', totalRules: opts.rulesPerCategory,
        triggeredBy: 'manual', scheduleId: null, runId: null,
        coveredScope: n % 3 === 0 ? narrowed : serializeCoveredScope([{ tenantId: EVERYTHING_TENANT_ID, path: '/' }]),
        coverage: 'complete', incompleteRules: '[]', hasRecords: 1,
      };
    });
    await run(db.insert(scans).values(rows));
  }

  // Two days of history through the real writer, a few rules failing in between so some levels differ.
  await run(db.delete(postureSnapshots));
  await refreshSnapshotsFor(categoryIds, new Date(now - 2 * DAY_MS));
  for (const rule of dataset.rules.filter((_, n) => n % 25 === 0)) {
    await run(db.update(rules).set({ lastRunStatus: 'failed' }).where(eq(rules.id, rule.id)));
  }
  await refreshSnapshotsFor(categoryIds, new Date(now - DAY_MS));
  timed('seeded', start);

  return { categoryIds, heldSubscriptions };
}

// ---- The measurements ----

export interface Measurement {
  name: string;
  /** How many runs follow the first, whose median is reported. 0 reports the first run alone. */
  runs: (warmRuns: number) => number;
  run: () => Promise<unknown>;
}

export interface MeasurementResult {
  name: string;
  coldMs: number;
  medianMs: number;
  /** The longest single run, where a measurement is several (one per category). */
  maxMs: number;
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

async function time(fn: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

/** A cold run, then `warmRuns` more: the median of those is the warm figure and the longest of all is the max. */
export async function runMeasurements(measurements: readonly Measurement[], warmRuns: number): Promise<MeasurementResult[]> {
  const results: MeasurementResult[] = [];
  for (const m of measurements) {
    const coldMs = await time(m.run);
    const warm: number[] = [];
    for (let i = 0; i < m.runs(warmRuns); i += 1) warm.push(await time(m.run));
    results.push({ name: m.name, coldMs, medianMs: warm.length ? median(warm) : coldMs, maxMs: Math.max(coldMs, ...warm) });
  }
  return results;
}

/** The access of a person who holds some whole subscriptions and nothing else. */
export function slicedAccess(subscriptions: readonly string[]): Access {
  return buildAccess(subscriptions.map(id => ({
    tenantId: TENANT, scope: { kind: 'subscription' as const, path: `/subscriptions/${id}` }, role: 'viewer' as const,
  })), 'manual');
}

export async function buildMeasurements(seeded: Seeded): Promise<Measurement[]> {
  const { refreshSnapshotsFor } = await import('../../lib/db/snapshots');
  const { computeWidgetSummary } = await import('../../lib/dashboard-data');
  const { listLastScanTimes } = await import('../../lib/scan-history');
  const { listCategories } = await import('../../lib/db/categories');

  const sliced = slicedAccess(seeded.heldSubscriptions);
  const window = { mode: 'relative' as const, days: 7 };
  const all = seeded.categoryIds;
  let next = 0;

  return [
    // Cold is the first refresh of the day; the warm runs after it find every level's point already there and rewrite them all.
    { name: 'one refresh, every category (cold: first of the day; warm: every level rewritten)', runs: w => w, run: () => refreshSnapshotsFor(all) },
    // One category on its own: the transaction it holds is most of this. Each run is the next category.
    {
      name: 'transaction hold, one category (median and longest over the categories)',
      runs: () => all.length - 1,
      run: () => refreshSnapshotsFor([all[next++ % all.length]!]),
    },
    { name: 'computeWidgetSummary, Everything', runs: w => w, run: () => computeWidgetSummary({ dateWindow: window }, BENCH_ACCESS) },
    { name: 'computeWidgetSummary, one category', runs: w => w, run: () => computeWidgetSummary({ dateWindow: window, categories: [all[0]!] }, BENCH_ACCESS) },
    { name: `computeWidgetSummary, holds ${seeded.heldSubscriptions.length} subscriptions`, runs: w => w, run: () => computeWidgetSummary({ dateWindow: window }, sliced) },
    {
      name: 'last-scanned read, Everything',
      runs: w => w,
      run: async () => listLastScanTimes((await listCategories()).map(c => c.id), BENCH_ACCESS),
    },
    {
      name: `last-scanned read, holds ${seeded.heldSubscriptions.length} subscriptions`,
      runs: w => w,
      run: async () => listLastScanTimes((await listCategories()).map(c => c.id), sliced),
    },
  ];
}

// ---- The run ----

export interface BenchOptions extends DatasetOptions { warmRuns: number }

export interface BenchResult {
  backend: string;
  machine: string;
  options: BenchOptions;
  counts: { subscriptions: number; categories: number; rules: number; findings: number; suppressed: number };
  /** The categories the dataset's categories were stored in, in the dataset's order. */
  categoryIds: string[];
  measurements: MeasurementResult[];
  /** The measurements whose longest run is over THRESHOLD_MS. */
  overThreshold: string[];
}

export function machineDescription(): string {
  const cpus = os.cpus();
  return `${cpus[0]?.model.trim() ?? 'unknown CPU'} x${cpus.length}, ${Math.round(os.totalmem() / 2 ** 30)} GB, ${os.platform()} ${os.release()}, Node ${process.version}`;
}

export async function runBench(opts: BenchOptions, log: (line: string) => void = () => {}): Promise<BenchResult> {
  const { dbKind } = await import('../../lib/db/backend');
  const dataset = generateDataset(opts);
  const seeded = await seedDatabase(dataset, opts, log);
  const measurements = await runMeasurements(await buildMeasurements(seeded), opts.warmRuns);
  return {
    backend: dbKind === 'pg' ? 'postgres' : 'sqlite',
    machine: machineDescription(),
    options: opts,
    counts: {
      subscriptions: dataset.subscriptions.length,
      categories: seeded.categoryIds.length,
      rules: dataset.rules.length,
      findings: dataset.findings.length,
      suppressed: dataset.findings.filter(f => f.suppressed).length,
    },
    categoryIds: seeded.categoryIds,
    measurements,
    overThreshold: measurements.filter(m => m.maxMs > THRESHOLD_MS).map(m => m.name),
  };
}

export function formatTable(result: BenchResult): string {
  const c = result.counts;
  const ms = (n: number): string => `${n >= 100 ? Math.round(n) : n.toFixed(1)} ms`;
  const rows = result.measurements.map(m => [m.name, ms(m.coldMs), ms(m.medianMs), ms(m.maxMs)]);
  const header = ['measurement', 'cold', 'median', 'longest'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => r[i]!.length)));
  const line = (cells: string[]): string => cells.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd();
  return [
    `Backend: ${result.backend}. Machine: ${result.machine}.`,
    `${c.subscriptions} subscriptions, ${c.categories} categories, ${c.rules} rules, ${c.findings} findings (${c.suppressed} suppressed), seed ${result.options.seed}, ${result.options.warmRuns} warm runs.`,
    '',
    line(header),
    line(widths.map(w => '-'.repeat(w))),
    ...rows.map(line),
    '',
    result.overThreshold.length
      ? `OVER the ${THRESHOLD_MS} ms threshold: ${result.overThreshold.join('; ')}. Send the spec back before the formula-3 change.`
      : `Every longest run is under the ${THRESHOLD_MS} ms threshold.`,
  ].join('\n');
}
