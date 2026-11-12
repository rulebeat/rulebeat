/**
 * Fixtures for the trend point writer's tests: rules inserted without going through the repository (which would
 * refresh the points itself), findings stored the way a scan leaves them, and the stored points read back by level.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { many, run } from '@/lib/db/exec';
import { postureSnapshots, rules as rulesTable } from '@/lib/db/tables';
import { storeScan, syntheticFinding } from './synthetic-findings';
import type { Finding } from '@/lib/types';

export interface RuleSeed {
  id: string;
  category?: string;
  enabled?: boolean;
  /** 'success' unless given. */
  lastRunStatus?: string | null;
  kind?: 'state' | 'activity' | 'advisory';
  queryBackend?: 'resource-graph' | 'microsoft-graph' | 'log-analytics';
  subscriptions?: string[];
  managementGroups?: string[];
}

/** Inserts a rule without refreshing any trend point. */
export async function insertRuleRow(seed: RuleSeed): Promise<void> {
  const backend = seed.queryBackend ?? 'resource-graph';
  await run(db.insert(rulesTable).values({
    id: seed.id,
    name: `Rule ${seed.id}`,
    description: 'test rule',
    category: seed.category ?? 'security',
    severity: 'medium',
    enabled: seed.enabled ?? true,
    scope: JSON.stringify({
      level: 'subscription',
      ...(seed.subscriptions ? { subscriptions: seed.subscriptions } : {}),
      ...(seed.managementGroups ? { managementGroups: seed.managementGroups } : {}),
    }),
    resourceTypes: '[]',
    conditions: '[]',
    rawKql: backend === 'resource-graph' ? 'resources | project id' : null,
    graphQuery: backend === 'microsoft-graph' ? JSON.stringify({ endpoint: 'applications', select: ['id'] }) : null,
    logsQuery: backend === 'log-analytics' ? JSON.stringify({ kql: 'SigninLogs', timeWindowDays: 7 }) : null,
    queryBackend: backend,
    kind: seed.kind ?? (backend === 'log-analytics' ? 'activity' : 'state'),
    type: 'custom',
    lastRunStatus: seed.lastRunStatus === undefined ? 'success' : seed.lastRunStatus,
  }));
}

let scanCounter = 0;

/** Stores findings as one scan of their category that ran every rule they name, plus `alsoRan`. */
export async function storeFindings(findings: Finding[], opts: { category?: string; alsoRan?: string[] } = {}): Promise<void> {
  scanCounter += 1;
  await storeScan(findings, {
    scanId: `00000000-0000-0000-0000-${String(scanCounter).padStart(12, '0')}`,
    category: opts.category,
    finishedAt: new Date().toISOString(),
    ranRuleIds: [...new Set([...findings.map(f => f.ruleId), ...(opts.alsoRan ?? [])])],
  });
}

export { syntheticFinding };

/** Every stored point of a category at a level (the install is ''), oldest first, with the level compared in lower case. */
export async function pointsAt(category: string, level: string) {
  const rows = await many(db.select().from(postureSnapshots).where(eq(postureSnapshots.category, category)));
  return rows.filter(r => r.subscriptionId.toLowerCase() === level.toLowerCase()).sort((a, b) => a.date.localeCompare(b.date));
}

/** The point of a category at a level on a day, or undefined. */
export async function pointOn(category: string, level: string, date: string) {
  return (await pointsAt(category, level)).find(p => p.date === date);
}

export async function allPoints(category: string) {
  return many(db.select().from(postureSnapshots).where(and(eq(postureSnapshots.category, category))));
}
