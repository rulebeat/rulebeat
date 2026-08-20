/**
 * Sample databases in the shapes older versions of RuleBeat left behind.
 *
 * Why builders rather than committed `.db` files or `.sql` scripts:
 *
 *  - A committed binary is the one format nobody can review or diff, and since the product has never
 *    been released there is no authentic old database to capture — it would be a shape we authored
 *    anyway, just stored unreadably. (Once v1 ships, a real `v1.db` fixture becomes worth adding, and
 *    this reasoning should be revisited.)
 *  - A `.sql` script handles the schema beautifully but not the content: a suppression has to carry a
 *    fingerprint that genuinely equals `computeFingerprint(ruleId, resourceId)` or case 25-09 asserts
 *    nothing, and hand-computed hashes in a text file go stale silently.
 *
 * Each shape is named for what it precedes rather than a version number, because there are no
 * versions. The DDL below is kept as literal SQL so it reads as a plain statement of what that era's
 * schema was.
 *
 * Note the current `CREATE TABLE` block in `lib/db/client.ts` is itself an *old* shape — `rules` has
 * no `type`/`tags`/`raw_kql`, `schedules` still has `cron`. Every install, fresh or upgraded, reaches
 * the current schema only by running the ALTERs. That's why `current` (an empty file) is a shape in
 * its own right.
 */
import Database from 'better-sqlite3';
import {
  ACTIVE_RESOURCE_ID, CUSTOM_RULES, FIXED_DATES, fingerprintFor,
  insertDashboard, insertFindings, insertRules, insertScans, insertSuppression, insertUsers,
} from './populate';

export type ShapeName =
  | 'policies-era'    // `policies` table; `rules`/`rule_groups`/`source` columns; hand-typed slug ids
  | 'legacy-rules'    // table renamed to `rules`, still legacy columns; `builtin::`-prefixed ids
  | 'cron-schedules'  // modern rules; old cron schedules; 2-column snapshot PK
  | 'pre-rbac'        // everything current except `users` and `audit_log` — the actual previous version
  | 'current';        // empty file: what a brand-new install starts from

export const SHAPES: ShapeName[] = ['policies-era', 'legacy-rules', 'cron-schedules', 'pre-rbac', 'current'];

/** What a builder put in, so a test can assert on exactly that rather than on hardcoded guesses. */
export interface BuiltShape {
  shape: ShapeName;
  /** Ids of the three user-authored rules. */
  customRuleIds: string[];
  /** Ids a migration is expected to rewrite. */
  legacyRuleIds: string[];
  /** The rule id findings/suppressions were keyed against when the fixture was written. */
  findingsRuleId: string | null;
  findingFingerprints: string[];
  suppressionFingerprint: string | null;
  scanId: string | null;
  dashboardId: string | null;
  hasUsers: boolean;
}

const EMPTY: Omit<BuiltShape, 'shape'> = {
  customRuleIds: [], legacyRuleIds: [], findingsRuleId: null, findingFingerprints: [],
  suppressionFingerprint: null, scanId: null, dashboardId: null, hasUsers: false,
};

/** Builds a sample database at `file`. Always closes its handle — Windows will not delete an open one. */
export function buildShape(name: ShapeName, file: string): BuiltShape {
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  try {
    switch (name) {
      case 'policies-era':   return { shape: name, ...buildPoliciesEra(sqlite) };
      case 'legacy-rules':   return { shape: name, ...buildLegacyRules(sqlite) };
      case 'cron-schedules': return { shape: name, ...buildCronSchedules(sqlite) };
      case 'pre-rbac':       return { shape: name, ...buildPreRbac(sqlite) };
      case 'current':        return { shape: name, ...EMPTY };
    }
  } finally {
    sqlite.close();
  }
}

// ── Shared DDL fragments ──────────────────────────────────────────────────────

const SCANS_LEGACY = `
  CREATE TABLE scans (
    id TEXT PRIMARY KEY,
    module TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    subscriptions_scanned TEXT NOT NULL,
    findings TEXT NOT NULL,
    counts TEXT NOT NULL
  );`;

const SUPPRESSIONS = `
  CREATE TABLE suppressions (
    id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    suppressed_at TEXT NOT NULL,
    expires_at TEXT
  );`;

const DASHBOARDS = `
  CREATE TABLE dashboards (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    config TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );`;

const FINDINGS = `
  CREATE TABLE findings (
    fingerprint TEXT PRIMARY KEY,
    rule_id TEXT NOT NULL,
    category TEXT NOT NULL,
    severity TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_name TEXT NOT NULL,
    subscription_id TEXT NOT NULL,
    resource_group TEXT,
    location TEXT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    recommendation TEXT NOT NULL DEFAULT '',
    remediation_steps TEXT NOT NULL DEFAULT '[]',
    evidence TEXT NOT NULL DEFAULT '{}',
    azure_portal_link TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    resolved_at TEXT,
    last_scan_id TEXT,
    times_seen INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE finding_events (
    id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    category TEXT NOT NULL,
    scan_id TEXT NOT NULL,
    type TEXT NOT NULL,
    occurred_at TEXT NOT NULL
  );`;

/** The rules table as it stands today, before the ALTERs that client.ts applies on every start. */
const RULES_MODERN = `
  CREATE TABLE rules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL,
    severity TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    scope TEXT NOT NULL,
    resource_types TEXT NOT NULL,
    filter TEXT,
    conditions TEXT NOT NULL DEFAULT '[]',
    condition_groups TEXT,
    project_columns TEXT,
    raw_kql TEXT,
    rules_operator TEXT,
    visual_query TEXT,
    type TEXT NOT NULL DEFAULT 'custom',
    pack TEXT,
    group_name TEXT,
    tags TEXT
  );`;

const CATEGORIES_AND_META = `
  CREATE TABLE categories (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    color TEXT,
    icon TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_builtin INTEGER NOT NULL DEFAULT 0,
    is_special INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`;

// ── The shapes ────────────────────────────────────────────────────────────────

/**
 * The oldest lineage: rules lived in a table called `policies`, conditions in a column called
 * `rules`, provenance in `source`, and the sample rules shipped with hand-typed slug ids.
 */
function buildPoliciesEra(sqlite: Database.Database): Omit<BuiltShape, 'shape'> {
  sqlite.exec(`
    CREATE TABLE policies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      severity TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      scope TEXT NOT NULL,
      resource_types TEXT NOT NULL,
      filter TEXT,
      rules TEXT NOT NULL DEFAULT '[]',
      rule_groups TEXT,
      source TEXT,
      group_name TEXT,
      project_columns TEXT
    );
    ${SCANS_LEGACY}
    ${SUPPRESSIONS}
    ${DASHBOARDS}
  `);

  const legacyIds = [
    'tag-required-environment', 'tag-environment-valid-values',
    'tag-required-costcenter', 'tag-required-owner',
  ];
  const ruleIds = insertRules(
    sqlite,
    { table: 'policies', legacyColumns: true, hasGroupName: true, hasRawKql: false },
    legacyIds,
  );
  const scanId = insertScans(sqlite, 'orphan::unattached-disk', 'tags');
  const dashboardId = insertDashboard(sqlite, legacyIds[0]!);
  const suppressionFingerprint = insertSuppression(sqlite, legacyIds[0]!);

  return {
    ...EMPTY,
    customRuleIds: ruleIds.slice(0, CUSTOM_RULES.length),
    legacyRuleIds: legacyIds,
    findingsRuleId: legacyIds[0]!,
    suppressionFingerprint,
    scanId,
    dashboardId,
  };
}

/**
 * The table has been renamed to `rules` but its columns have not, and rule ids still carry the
 * `builtin::` prefix scheme. The densest shape — most of the risky migration code is only reachable
 * from here.
 */
function buildLegacyRules(sqlite: Database.Database): Omit<BuiltShape, 'shape'> {
  sqlite.exec(`
    CREATE TABLE rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      severity TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      scope TEXT NOT NULL,
      resource_types TEXT NOT NULL,
      filter TEXT,
      rules TEXT NOT NULL DEFAULT '[]',
      rule_groups TEXT,
      source TEXT,
      group_name TEXT,
      raw_kql TEXT,
      project_columns TEXT
    );
    ${SCANS_LEGACY}
    ${SUPPRESSIONS}
    ${DASHBOARDS}
    ${FINDINGS}
    ${CATEGORIES_AND_META}
  `);

  const legacyIds = [
    'builtin::orphan-unattached-disk',
    'builtin::standards-storage-https',
    'builtin::tag-environment',
  ];
  const ruleIds = insertRules(
    sqlite,
    { table: 'rules', legacyColumns: true, hasGroupName: true, hasRawKql: true },
    legacyIds,
  );

  const findingsRuleId = legacyIds[0]!;
  const scanId = insertScans(sqlite, 'orphan::unattached-disk', 'orphans');
  const findingFingerprints = insertFindings(sqlite, findingsRuleId);
  const suppressionFingerprint = insertSuppression(sqlite, findingsRuleId);
  const dashboardId = insertDashboard(sqlite, findingsRuleId);

  sqlite.prepare(`
    INSERT INTO finding_events (id, fingerprint, rule_id, category, scan_id, type, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'e0000000-0000-4000-8000-000000000001', findingFingerprints[0], findingsRuleId,
    'cost', scanId, 'new', FIXED_DATES.firstSeen,
  );

  return {
    ...EMPTY,
    customRuleIds: ruleIds.slice(0, CUSTOM_RULES.length),
    legacyRuleIds: legacyIds,
    findingsRuleId,
    findingFingerprints,
    suppressionFingerprint,
    scanId,
    dashboardId,
  };
}

/**
 * Rules are modern, but the two *structural* migrations have not run: schedules still use the
 * cron-preset model, and `compliance_snapshots` still has the two-column primary key. Isolating
 * these from the column renames means a failure here localises to a table rebuild or a DROP COLUMN.
 */
function buildCronSchedules(sqlite: Database.Database): Omit<BuiltShape, 'shape'> {
  sqlite.exec(`
    ${RULES_MODERN}
    ${SCANS_LEGACY}
    ${SUPPRESSIONS}
    ${DASHBOARDS}
    ${FINDINGS}
    ${CATEGORIES_AND_META}

    CREATE TABLE schedules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      categories TEXT NOT NULL,
      frequency TEXT NOT NULL,
      cron TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      next_run_at TEXT,
      last_run_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE schedule_runs (
      id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      categories TEXT NOT NULL,
      total_findings INTEGER NOT NULL DEFAULT 0,
      new_findings INTEGER NOT NULL DEFAULT 0,
      new_finding_fingerprints TEXT,
      error TEXT,
      duration_ms INTEGER
    );

    CREATE TABLE compliance_snapshots (
      category TEXT NOT NULL,
      date TEXT NOT NULL,
      compliance_pct INTEGER,
      passing_rules INTEGER NOT NULL DEFAULT 0,
      total_rules INTEGER NOT NULL DEFAULT 0,
      active_findings INTEGER NOT NULL DEFAULT 0,
      severity_counts TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (category, date)
    );
  `);

  // A pack rule still on the old prefixed id scheme, with `pack` set — which is what the dynamic
  // APRL rename keys off.
  const aprlLegacyId = 'builtin::aprl-11111111-2222-4333-8444-555555555555';
  const ruleIds = insertRules(
    sqlite,
    { table: 'rules', legacyColumns: false, hasGroupName: true, hasRawKql: true },
    [aprlLegacyId],
  );
  sqlite.prepare(`UPDATE rules SET pack = 'aprl-v2', type = 'builtin' WHERE id = ?`).run(aprlLegacyId);

  const findingsRuleId = CUSTOM_RULES[0].id;
  const scanId = insertScans(sqlite, findingsRuleId, 'cost');
  const findingFingerprints = insertFindings(sqlite, findingsRuleId);
  const suppressionFingerprint = insertSuppression(sqlite, findingsRuleId);
  const dashboardId = insertDashboard(sqlite, findingsRuleId);

  sqlite.prepare(`
    INSERT INTO schedules (id, name, categories, frequency, cron, enabled, next_run_at, last_run_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'sch00000-0000-4000-8000-000000000001', 'Nightly cost sweep',
    JSON.stringify(['cost', 'security']), 'daily', '0 2 * * *', 1,
    '2026-07-21T02:00:00.000Z', '2026-07-20T02:00:00.000Z',
    FIXED_DATES.installed, FIXED_DATES.installed,
  );
  sqlite.prepare(`
    INSERT INTO schedules (id, name, categories, frequency, cron, enabled, next_run_at, last_run_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'sch00000-0000-4000-8000-000000000002', 'Everything, weekly',
    JSON.stringify(['*']), 'weekly', '0 3 * * 1', 1, null, null,
    FIXED_DATES.installed, FIXED_DATES.installed,
  );

  sqlite.prepare(`
    INSERT INTO schedule_runs (id, schedule_id, started_at, finished_at, status, categories, total_findings, new_findings)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'r0000000-0000-4000-8000-000000000001', 'sch00000-0000-4000-8000-000000000001',
    FIXED_DATES.scanStarted, FIXED_DATES.scanFinished, 'success', JSON.stringify(['cost']), 4, 1,
  );

  sqlite.prepare(`
    INSERT INTO compliance_snapshots (category, date, compliance_pct, passing_rules, total_rules, active_findings, severity_counts, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('cost', '2026-07-19', 80, 8, 10, 4, '{"high":1}', FIXED_DATES.lastSeen);

  return {
    ...EMPTY,
    customRuleIds: ruleIds.slice(0, CUSTOM_RULES.length),
    legacyRuleIds: [aprlLegacyId],
    findingsRuleId,
    findingFingerprints,
    suppressionFingerprint,
    scanId,
    dashboardId,
  };
}

/**
 * The genuine "previous version": everything current except access control, which landed on
 * 2026-07-28. This is the shape any real pre-launch install is actually in.
 */
function buildPreRbac(sqlite: Database.Database): Omit<BuiltShape, 'shape'> {
  sqlite.exec(`
    ${RULES_MODERN}
    ${SUPPRESSIONS}
    ${DASHBOARDS}
    ${FINDINGS}
    ${CATEGORIES_AND_META}

    CREATE TABLE scans (
      id TEXT PRIMARY KEY,
      module TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      subscriptions_scanned TEXT NOT NULL,
      findings TEXT NOT NULL,
      counts TEXT NOT NULL,
      triggered_by TEXT NOT NULL DEFAULT 'manual',
      schedule_id TEXT,
      run_id TEXT,
      total_rules INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE schedules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      next_run_at TEXT,
      last_run_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      target_type TEXT NOT NULL DEFAULT 'all',
      target_values TEXT NOT NULL DEFAULT '[]',
      recurrence_type TEXT NOT NULL DEFAULT 'once',
      interval INTEGER NOT NULL DEFAULT 1,
      days_of_week TEXT,
      day_of_month INTEGER,
      start_at TEXT NOT NULL DEFAULT '',
      end_type TEXT NOT NULL DEFAULT 'never',
      end_date TEXT
    );

    CREATE TABLE schedule_runs (
      id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      categories TEXT NOT NULL,
      total_findings INTEGER NOT NULL DEFAULT 0,
      new_findings INTEGER NOT NULL DEFAULT 0,
      new_finding_fingerprints TEXT,
      error TEXT,
      duration_ms INTEGER,
      triggered_by TEXT NOT NULL DEFAULT 'schedule',
      target_type TEXT,
      target_values TEXT
    );

    CREATE TABLE compliance_snapshots (
      category TEXT NOT NULL,
      subscription_id TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL,
      compliance_pct INTEGER,
      passing_rules INTEGER NOT NULL DEFAULT 0,
      total_rules INTEGER NOT NULL DEFAULT 0,
      active_findings INTEGER NOT NULL DEFAULT 0,
      severity_counts TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (category, subscription_id, date)
    );
  `);

  const ruleIds = insertRules(
    sqlite,
    { table: 'rules', legacyColumns: false, hasGroupName: true, hasRawKql: true },
  );

  const findingsRuleId = CUSTOM_RULES[0].id;
  const findingFingerprints = insertFindings(sqlite, findingsRuleId);
  const suppressionFingerprint = insertSuppression(sqlite, findingsRuleId);
  const dashboardId = insertDashboard(sqlite, findingsRuleId);

  sqlite.prepare(`
    INSERT INTO scans (id, module, started_at, finished_at, duration_ms, subscriptions_scanned, findings, counts, triggered_by, total_rules)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    's0000000-0000-4000-8000-000000000009', 'cost',
    FIXED_DATES.scanStarted, FIXED_DATES.scanFinished, 300_000,
    JSON.stringify(['11111111-1111-1111-1111-111111111111']),
    JSON.stringify([{ fingerprint: fingerprintFor(findingsRuleId, ACTIVE_RESOURCE_ID), ruleId: findingsRuleId, resourceId: ACTIVE_RESOURCE_ID }]),
    JSON.stringify({ critical: 0, high: 1, medium: 0, low: 0 }), 'manual', 12,
  );

  return {
    ...EMPTY,
    customRuleIds: ruleIds.slice(0, CUSTOM_RULES.length),
    findingsRuleId,
    findingFingerprints,
    suppressionFingerprint,
    scanId: 's0000000-0000-4000-8000-000000000009',
    dashboardId,
  };
}

/** Users are inserted separately so the RBAC-era shapes can share one writer. */
export function addUsers(file: string): void {
  const sqlite = new Database(file);
  try {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        oid TEXT UNIQUE,
        name TEXT,
        role TEXT NOT NULL DEFAULT 'viewer',
        scope TEXT,
        created_at TEXT NOT NULL,
        last_seen_at TEXT
      );
    `);
    insertUsers(sqlite);
  } finally {
    sqlite.close();
  }
}
