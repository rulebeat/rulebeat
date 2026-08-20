/**
 * The content every sample database is filled with, and the writers that put it there.
 *
 * One logical set of content — three custom rules, a month of scan history, a dashboard, an admin,
 * a suppression that really matches a finding — written into whichever era's column layout the
 * fixture uses. Keeping the *content* shared is what lets one assertion ("the three custom rules
 * survived with their KQL intact") be run against every shape without rewriting it per era.
 *
 * The suppression's fingerprint is computed with the product's own `computeFingerprint`, not typed
 * by hand. A hand-written hash would drift silently the day the formula changes, and case 25-09
 * ("suppressions still suppress") would then be asserting nothing.
 */
import type { Database } from 'better-sqlite3';
import { computeFingerprint } from '@rulebeat/core';

// ── The content ───────────────────────────────────────────────────────────────

/** Rules a user wrote themselves. These are the ones an upgrade must never lose. */
export const CUSTOM_RULES = [
  {
    id: 'c0000000-0000-4000-8000-000000000001',
    name: 'Storage accounts must be zone redundant',
    description: 'Checks the SKU name for a ZRS suffix.',
    category: 'reliability',
    severity: 'high',
    rawKql: "Resources\n| where type =~ 'microsoft.storage/storageaccounts'\n| where sku.name !endswith 'ZRS'\n| project id, name, type, location, resourceGroup, subscriptionId, tags",
  },
  {
    id: 'c0000000-0000-4000-8000-000000000002',
    name: 'VMs in the retired region',
    description: 'Anything still running in westeurope.',
    category: 'compliance',
    severity: 'medium',
    rawKql: "Resources\n| where type =~ 'microsoft.compute/virtualmachines'\n| where location =~ 'westeurope'\n| project id, name, type, location, resourceGroup, subscriptionId, tags",
  },
  {
    id: 'c0000000-0000-4000-8000-000000000003',
    name: 'Disks over 512 GB',
    description: 'Cost check on oversized managed disks.',
    category: 'cost',
    severity: 'low',
    rawKql: "Resources\n| where type =~ 'microsoft.compute/disks'\n| where tolong(properties.diskSizeGB) > 512\n| project id, name, type, location, resourceGroup, subscriptionId, tags",
  },
] as const;

/** The person who installed it. Losing this row means losing access to your own install. */
export const ADMIN_USER = {
  id: 'u0000000-0000-4000-8000-000000000001',
  email: 'admin@example.com',
  oid: '00000000-1111-4000-8000-000000000001',
  name: 'Existing Admin',
  role: 'admin',
} as const;

export const VIEWER_USER = {
  id: 'u0000000-0000-4000-8000-000000000002',
  email: 'viewer@example.com',
  oid: '00000000-1111-4000-8000-000000000002',
  name: 'Existing Viewer',
  role: 'viewer',
} as const;

/** A resource carrying an active finding, which a suppression then silences. */
export const SUPPRESSED_RESOURCE_ID =
  '/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-legacy/providers/Microsoft.Storage/storageAccounts/stlegacy001';

export const ACTIVE_RESOURCE_ID =
  '/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-legacy/providers/Microsoft.Compute/virtualMachines/vm-legacy-01';

export const FIXED_DATES = {
  installed: '2026-05-01T09:00:00.000Z',
  firstSeen: '2026-06-02T09:00:00.000Z',
  lastSeen: '2026-07-20T09:00:00.000Z',
  scanStarted: '2026-07-20T08:55:00.000Z',
  scanFinished: '2026-07-20T09:00:00.000Z',
} as const;

/** The fingerprint a finding gets, given whichever rule id that era used. */
export function fingerprintFor(ruleId: string, resourceId: string): string {
  return computeFingerprint(ruleId, resourceId);
}

// ── Writers ───────────────────────────────────────────────────────────────────

export interface RuleColumns {
  /** `policies` in the oldest era, `rules` after the table rename. */
  table: 'policies' | 'rules';
  /** Pre-rename column names: `rules`/`rule_groups`/`source` rather than the current ones. */
  legacyColumns: boolean;
  /** Single-value `group_name`, before it became the multi-value `tags` column. */
  hasGroupName: boolean;
  /** Present from the era `rawKql` was introduced onward. */
  hasRawKql: boolean;
}

/**
 * Writes the three custom rules plus, optionally, rules carrying legacy ids that later migrations
 * rename. Returns every id written, so a test can assert on exactly what it put in.
 */
export function insertRules(
  sqlite: Database,
  cols: RuleColumns,
  legacyIds: string[] = [],
): string[] {
  const conditionsCol = cols.legacyColumns ? 'rules' : 'conditions';
  const groupsCol = cols.legacyColumns ? 'rule_groups' : 'condition_groups';
  const typeCol = cols.legacyColumns ? 'source' : 'type';

  const names = [
    'id', 'name', 'description', 'category', 'severity', 'enabled',
    'scope', 'resource_types', conditionsCol, groupsCol, typeCol,
    ...(cols.hasGroupName ? ['group_name'] : []),
    ...(cols.hasRawKql ? ['raw_kql'] : []),
  ];
  const stmt = sqlite.prepare(
    `INSERT INTO ${cols.table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
  );

  const written: string[] = [];

  for (const rule of CUSTOM_RULES) {
    const values: unknown[] = [
      rule.id, rule.name, rule.description, rule.category, rule.severity, 1,
      JSON.stringify({ level: 'resource' }), JSON.stringify(['*']),
      JSON.stringify([{ field: 'name', operator: 'startsWith', value: 'x' }]),
      JSON.stringify([{ id: 'g1', conditions: [{ field: 'location', operator: 'equals', value: 'westeurope' }] }]),
      'custom',
      ...(cols.hasGroupName ? ['Production'] : []),
      ...(cols.hasRawKql ? [rule.rawKql] : []),
    ];
    stmt.run(...values);
    written.push(rule.id);
  }

  // Rules whose ids a later migration rewrites. Their content is what proves the rename carried the
  // row across rather than deleting it and re-seeding a blank one.
  for (const legacyId of legacyIds) {
    stmt.run(
      legacyId, `Legacy rule ${legacyId}`, 'Seeded under an older id scheme.',
      'cost', 'medium', 0, // disabled — a user edit that must survive the rename
      JSON.stringify({ level: 'resource' }), JSON.stringify(['*']),
      JSON.stringify([]), JSON.stringify([]), 'builtin',
      ...(cols.hasGroupName ? ['Legacy'] : []),
      ...(cols.hasRawKql ? ['Resources | project id'] : []),
    );
    written.push(legacyId);
  }

  return written;
}

/** Scan history, including the old module names and old rule-id prefixes inside the findings blob. */
export function insertScans(sqlite: Database, ruleId: string, module = 'orphans'): string {
  const scanId = 's0000000-0000-4000-8000-000000000001';
  const findings = JSON.stringify([
    {
      fingerprint: fingerprintFor(ruleId, ACTIVE_RESOURCE_ID),
      ruleId,
      resourceId: ACTIVE_RESOURCE_ID,
      resourceName: 'vm-legacy-01',
      severity: 'high',
      title: 'A pre-upgrade finding',
    },
  ]);
  sqlite.prepare(`
    INSERT INTO scans (id, module, started_at, finished_at, duration_ms, subscriptions_scanned, findings, counts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    scanId, module, FIXED_DATES.scanStarted, FIXED_DATES.scanFinished, 300_000,
    JSON.stringify(['11111111-1111-1111-1111-111111111111']), findings,
    JSON.stringify({ critical: 0, high: 1, medium: 0, low: 0 }),
  );
  return scanId;
}

/** A finding mid-lifecycle: seen repeatedly over weeks. Its age is what an upgrade must not reset. */
export function insertFindings(sqlite: Database, ruleId: string): string[] {
  const stmt = sqlite.prepare(`
    INSERT INTO findings (
      fingerprint, rule_id, category, severity, resource_id, resource_type, resource_name,
      subscription_id, resource_group, location, title, status, first_seen_at, last_seen_at, times_seen
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const written: string[] = [];
  for (const [resourceId, name] of [
    [ACTIVE_RESOURCE_ID, 'vm-legacy-01'],
    [SUPPRESSED_RESOURCE_ID, 'stlegacy001'],
  ] as const) {
    const fp = fingerprintFor(ruleId, resourceId);
    stmt.run(
      fp, ruleId, 'cost', 'high', resourceId,
      'microsoft.compute/virtualmachines', name,
      '11111111-1111-1111-1111-111111111111', 'rg-legacy', 'westeurope',
      `Finding for ${name}`, 'active', FIXED_DATES.firstSeen, FIXED_DATES.lastSeen, 12,
    );
    written.push(fp);
  }
  return written;
}

/** The suppression that must still be silencing the same finding after the upgrade. */
export function insertSuppression(sqlite: Database, ruleId: string): string {
  const fp = fingerprintFor(ruleId, SUPPRESSED_RESOURCE_ID);
  sqlite.prepare(`
    INSERT INTO suppressions (id, fingerprint, resource_id, reason, suppressed_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    'sup00000-0000-4000-8000-000000000001', fp, SUPPRESSED_RESOURCE_ID,
    'Accepted risk, reviewed by the platform team', FIXED_DATES.firstSeen, null,
  );
  return fp;
}

/** A dashboard whose saved layout and filters must come through unchanged. */
export function insertDashboard(sqlite: Database, ruleId: string): string {
  const id = 'd0000000-0000-4000-8000-000000000001';
  const config = JSON.stringify({
    widgets: [
      { id: 'w1', type: 'stat-card', metric: 'openFindings', layout: { x: 0, y: 0, w: 3, h: 2 }, filters: { category: 'cost' } },
      { id: 'w2', type: 'top-policies', layout: { x: 3, y: 0, w: 6, h: 4 }, filters: { ruleId } },
    ],
    filters: { category: 'cost', dateWindow: { mode: 'relative', days: 7 } },
  });
  sqlite.prepare(`
    INSERT INTO dashboards (id, name, description, config, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, 'My dashboard', 'Built before the upgrade', config, 1, FIXED_DATES.installed);
  return id;
}

export function insertUsers(sqlite: Database): void {
  const stmt = sqlite.prepare(
    `INSERT INTO users (id, email, oid, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const u of [ADMIN_USER, VIEWER_USER]) {
    stmt.run(u.id, u.email, u.oid, u.name, u.role, FIXED_DATES.installed);
  }
}
