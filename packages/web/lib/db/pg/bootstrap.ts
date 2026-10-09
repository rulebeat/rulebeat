import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as pgSchema from '../schema.pg';
import {
  FINGERPRINT_CASE_MARKER, REKEY_READS, planFingerprintRekey,
  type RekeyFindingRow, type RekeyScheduleRunRow, type RekeySuppressionRow,
} from '../fingerprint-rekey';
import {
  FINDING_ROWS_COPY_MARKER, ROW_COPY_DELETE_ORPHANS, ROW_COPY_READ_ALL, ROW_COPY_READ_BACK, ROW_COPY_READ_STALE,
  planRowCopy, rowCopyMismatch,
  type RowCopySource, type RowRecord,
} from '../finding-rows-copy';
import {
  CATALOGUE_READ_BACK, CATALOGUE_READ_RULES, COLUMN_CATALOGUE_MARKER, PathCollector, catalogueMismatch,
  type CatalogueRecord,
} from '../column-catalogue-build';

/**
 * Brings a Postgres database up to the current schema. The Postgres analog of `migrate.ts`'s
 * `runMigrations()`, but deliberately much simpler: Postgres support starts empty (there is no
 * pre-existing install to upgrade and no SQLite-to-Postgres data migration), so this is a plain
 * idempotent CREATE TABLE IF NOT EXISTS set generated from `schema.pg.ts`, not a migration chain.
 * `migrate.ts` and the SQLite upgrade path are untouched by design.
 *
 * DDL mirrors `schema.pg.ts` exactly; see that file for why timestamps and JSON stay TEXT and
 * where the `seq` columns come from. Indexes mirror the SQLite base DDL in `migrate.ts`. Once a
 * Postgres schema change ships in a release, it must be added here as an idempotent statement
 * (ALTER TABLE ... ADD COLUMN IF NOT EXISTS), keeping this file the one executable definition of
 * the Postgres schema.
 */
const DDL = `
CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  scope TEXT NOT NULL,
  resource_types TEXT NOT NULL,
  filter TEXT,
  conditions TEXT NOT NULL DEFAULT '[]',
  project_columns TEXT,
  raw_kql TEXT,
  condition_groups TEXT,
  type TEXT NOT NULL DEFAULT 'custom',
  pack TEXT,
  query_backend TEXT NOT NULL DEFAULT 'resource-graph',
  graph_query TEXT,
  logs_query TEXT,
  kind TEXT NOT NULL DEFAULT 'state',
  group_name TEXT,
  tags TEXT,
  visual_query TEXT,
  last_run_status TEXT,
  last_run_at TEXT,
  version TEXT,
  retired_at TEXT,
  origin_rule_id TEXT,
  origin_version TEXT
);
-- Applies to was removed; drop its columns from a database bootstrapped while it existed.
ALTER TABLE rules DROP COLUMN IF EXISTS applies_to;
ALTER TABLE rules DROP COLUMN IF EXISTS last_population_count;
ALTER TABLE rules DROP COLUMN IF EXISTS shape;
-- Rule versions (#152), for a Postgres database bootstrapped before these columns shipped.
ALTER TABLE rules ADD COLUMN IF NOT EXISTS version TEXT;
ALTER TABLE rules ADD COLUMN IF NOT EXISTS retired_at TEXT;
ALTER TABLE rules ADD COLUMN IF NOT EXISTS origin_rule_id TEXT;
ALTER TABLE rules ADD COLUMN IF NOT EXISTS origin_version TEXT;

CREATE TABLE IF NOT EXISTS rule_versions (
  rule_id TEXT NOT NULL,
  version TEXT NOT NULL,
  sort_key TEXT NOT NULL,
  release_note TEXT NOT NULL,
  definition TEXT NOT NULL,
  upstream_ref TEXT,
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (rule_id, version)
);

CREATE TABLE IF NOT EXISTS scans (
  id TEXT PRIMARY KEY,
  module TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  subscriptions_scanned TEXT NOT NULL,
  findings TEXT NOT NULL,
  counts TEXT NOT NULL,
  total_rules INTEGER NOT NULL DEFAULT 0,
  triggered_by TEXT NOT NULL DEFAULT 'manual',
  schedule_id TEXT,
  run_id TEXT,
  coverage TEXT NOT NULL DEFAULT 'complete',
  incomplete_rules TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_scans_module_started ON scans(module, started_at DESC);

CREATE TABLE IF NOT EXISTS suppressions (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  resource_id TEXT,
  reason TEXT NOT NULL,
  suppressed_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS schema_cache (
  resource_type TEXT PRIMARY KEY,
  fields TEXT NOT NULL,
  cached_at TEXT NOT NULL,
  field_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS resource_types_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  types TEXT NOT NULL,
  cached_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dashboards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  config TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  color TEXT,
  icon TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_builtin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT 'all',
  target_values TEXT NOT NULL DEFAULT '[]',
  recurrence_type TEXT NOT NULL DEFAULT 'once',
  "interval" INTEGER NOT NULL DEFAULT 1,
  days_of_week TEXT,
  day_of_month INTEGER,
  start_at TEXT NOT NULL,
  end_type TEXT NOT NULL DEFAULT 'never',
  end_date TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  next_run_at TEXT,
  last_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  oid TEXT UNIQUE,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'viewer',
  scope TEXT,
  session_epoch INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_oid ON users(oid);

CREATE TABLE IF NOT EXISTS azure_credentials (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_verified_at TEXT,
  last_verified_subscriptions INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS log_analytics_workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS local_accounts (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  password_updated_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sso_providers (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  last_verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  summary TEXT NOT NULL,
  details TEXT,
  occurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_log_occurred ON audit_log(occurred_at DESC);

CREATE TABLE IF NOT EXISTS findings (
  fingerprint TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'state',
  dimension_key TEXT,
  resource_id TEXT,
  resource_type TEXT,
  resource_name TEXT,
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
  times_seen INTEGER NOT NULL DEFAULT 1,
  evidence_rows TEXT
);
CREATE INDEX IF NOT EXISTS idx_findings_category_status ON findings(category, status);
CREATE INDEX IF NOT EXISTS idx_findings_rule ON findings(rule_id);

-- Every row a finding's rule returned for it (#192); null reads as one row made from evidence.
ALTER TABLE findings ADD COLUMN IF NOT EXISTS evidence_rows TEXT;

-- ADR 0007: a finding's rows in their own table, plain JSON text (not jsonb, which reorders keys),
-- the finding's row count and the scan its rows were written for. Kept in step by copyFindingRows().
CREATE TABLE IF NOT EXISTS finding_rows (
  fingerprint TEXT NOT NULL,
  position INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (fingerprint, position)
);
ALTER TABLE findings ADD COLUMN IF NOT EXISTS row_count INTEGER;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS rows_scan_id TEXT;

-- The columns each rule's findings returned. Filled once by buildColumnCatalogue(), then kept
-- in step by every scan save.
CREATE TABLE IF NOT EXISTS column_catalogue (
  rule_id TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (rule_id, path)
);

CREATE TABLE IF NOT EXISTS finding_events (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  category TEXT NOT NULL,
  scan_id TEXT NOT NULL,
  type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  row_payload TEXT
);
CREATE INDEX IF NOT EXISTS idx_finding_events_time ON finding_events(occurred_at DESC);

-- The row a 'row_added' / 'row_removed' event is about (#193); null for every other event type.
ALTER TABLE finding_events ADD COLUMN IF NOT EXISTS row_payload TEXT;

CREATE TABLE IF NOT EXISTS posture_snapshots (
  category TEXT NOT NULL,
  subscription_id TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  posture_pct INTEGER,
  passing_rules INTEGER NOT NULL DEFAULT 0,
  total_rules INTEGER NOT NULL DEFAULT 0,
  unknown_rules INTEGER NOT NULL DEFAULT 0,
  activity_rule_count INTEGER NOT NULL DEFAULT 0,
  formula_version INTEGER NOT NULL DEFAULT 1,
  active_findings INTEGER NOT NULL DEFAULT 0,
  severity_counts TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (category, subscription_id, date)
);
CREATE INDEX IF NOT EXISTS idx_snapshots_date ON posture_snapshots(date DESC);

CREATE TABLE IF NOT EXISTS notification_channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  url TEXT NOT NULL,
  config TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_notified_at TEXT,
  last_error TEXT,
  include_advisories BOOLEAN NOT NULL DEFAULT FALSE
);
-- Include advisories (#180), for a Postgres database bootstrapped before this column shipped. Every
-- existing channel reads back off.
ALTER TABLE notification_channels ADD COLUMN IF NOT EXISTS include_advisories BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS schedule_notification_channels (
  schedule_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  min_severity TEXT NOT NULL DEFAULT 'high',
  category_ids TEXT,
  subscription_ids TEXT,
  PRIMARY KEY (schedule_id, channel_id)
);

CREATE TABLE IF NOT EXISTS schedule_runs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  triggered_by TEXT NOT NULL DEFAULT 'schedule',
  target_type TEXT,
  target_values TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  categories TEXT NOT NULL,
  total_findings INTEGER NOT NULL DEFAULT 0,
  new_findings INTEGER NOT NULL DEFAULT 0,
  new_finding_fingerprints TEXT,
  error TEXT,
  duration_ms INTEGER,
  notify_status TEXT NOT NULL DEFAULT 'none',
  notify_claimed_at TEXT,
  heartbeat_at TEXT,
  owner_id TEXT,
  changed_findings TEXT
);
CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule ON schedule_runs(schedule_id, started_at DESC);
-- Overlap safety (issue #88), for a Postgres database bootstrapped before these columns shipped.
ALTER TABLE schedule_runs ADD COLUMN IF NOT EXISTS notify_claimed_at TEXT;
ALTER TABLE schedule_runs ADD COLUMN IF NOT EXISTS heartbeat_at TEXT;
ALTER TABLE schedule_runs ADD COLUMN IF NOT EXISTS owner_id TEXT;
-- Findings that gained a row, carried to notification dispatch and recovery (#193).
ALTER TABLE schedule_runs ADD COLUMN IF NOT EXISTS changed_findings TEXT;

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id TEXT PRIMARY KEY,
  seq BIGSERIAL,
  channel_id TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  ok BOOLEAN NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  http_status INTEGER,
  error TEXT,
  findings_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_channel
  ON notification_deliveries(channel_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS saved_queries (
  id TEXT PRIMARY KEY,
  seq BIGSERIAL,
  name TEXT NOT NULL,
  query_backend TEXT NOT NULL,
  scope TEXT,
  visual_query TEXT,
  raw_kql TEXT,
  graph_query TEXT,
  logs_query TEXT,
  visibility TEXT NOT NULL DEFAULT 'private',
  owner_id TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_run_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_saved_queries_owner ON saved_queries(owner_id, visibility);

CREATE TABLE IF NOT EXISTS query_runs (
  id TEXT PRIMARY KEY,
  seq BIGSERIAL,
  query_backend TEXT NOT NULL,
  scope TEXT,
  raw_kql TEXT,
  graph_query TEXT,
  logs_query TEXT,
  count INTEGER NOT NULL,
  capped BOOLEAN NOT NULL,
  truncated BOOLEAN NOT NULL,
  saved_query_id TEXT,
  owner_id TEXT NOT NULL,
  ran_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_query_runs_owner ON query_runs(owner_id, ran_at DESC);

CREATE TABLE IF NOT EXISTS saved_views (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tab TEXT NOT NULL,
  query TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);
`;

/**
 * Arbitrary but fixed: every RuleBeat process bootstrapping the same database takes the same
 * advisory lock, so two containers booting at once (a rolling deploy's first Postgres start, or a
 * scaled-out mistake) run the DDL one after the other instead of colliding inside
 * `CREATE TABLE IF NOT EXISTS`, which is not atomic across sessions and fails the loser with a
 * duplicate-key error on the catalog (issue #88).
 */
const BOOTSTRAP_LOCK_KEY = 7385562991;

export async function bootstrapPg(db: NodePgDatabase<typeof pgSchema>): Promise<void> {
  // A transaction-scoped lock releases itself with the transaction, including on error, so a
  // failed bootstrap can never leave the lock held for the process's lifetime.
  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`));
    await tx.execute(sql.raw(DDL));
    // A savepoint, so a failure rolls back only the rekey and the schema bootstrap still commits:
    // a one-time data step must never stop the app booting. It is retried on the next start.
    try {
      await tx.transaction(async (sp) => { await rekeyFingerprintCase(sp); });
    } catch (err) {
      console.error('[bootstrap] could not move finding fingerprints onto the case-insensitive formula:', err);
    }
    // After the rekey, and in its own savepoint for the same reason.
    try {
      await tx.transaction(async (sp) => { await copyFindingRows(sp); });
    } catch (err) {
      console.error('[bootstrap] could not copy finding rows into their own table:', err);
    }
    // After the copy, whose rows it reads, and in its own savepoint for the same reason.
    try {
      await tx.transaction(async (sp) => { await buildColumnCatalogue(sp); });
    } catch (err) {
      console.error('[bootstrap] could not build the column catalogue:', err);
    }
  });
}

type PgTx = Parameters<Parameters<NodePgDatabase<typeof pgSchema>['transaction']>[0]>[0];

/**
 * The Postgres half of migrate.ts's rekeyFingerprintCase(): the same plan, run once, inside the
 * bootstrap's own locked transaction so two booting containers cannot both apply it. Postgres
 * installs since 0.7.0 hold fingerprints from the case-sensitive formula too.
 */
async function rekeyFingerprintCase(tx: PgTx): Promise<void> {
  const marker = await tx.execute(sql`SELECT value FROM meta WHERE key = ${FINGERPRINT_CASE_MARKER}`);
  if (marker.rows.length > 0) return;
  const read = async <T>(query: string) => (await tx.execute(sql.raw(query))).rows as T[];
  const statements = planFingerprintRekey({
    findings: await read<RekeyFindingRow>(REKEY_READS.findings),
    suppressions: await read<RekeySuppressionRow>(REKEY_READS.suppressions),
    ruleIds: (await read<{ id: string }>(REKEY_READS.rules)).map(r => r.id),
    scheduleRuns: await read<RekeyScheduleRunRow>(REKEY_READS.scheduleRuns),
  });
  for (const s of statements) {
    const parts = s.sql.split('?');
    const chunks = parts.flatMap((part, i) => (i < s.params.length ? [sql.raw(part), sql`${s.params[i]}`] : [sql.raw(part)]));
    await tx.execute(sql.join(chunks, sql.raw('')));
  }
  await tx.execute(sql`INSERT INTO meta (key, value) VALUES (${FINGERPRINT_CASE_MARKER}, ${new Date().toISOString()}) ON CONFLICT (key) DO NOTHING`);
}

/** 1000 a statement keeps each well under Postgres's 65535 bind parameters. */
function batches<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += 1000) out.push(items.slice(i, i + 1000));
  return out;
}

/** The Postgres half of migrate.ts's copyFindingRows(): the same plan and the same proof. A throw
 *  rolls the savepoint back, so a copy that fails changes nothing. */
async function copyFindingRows(tx: PgTx): Promise<void> {
  const copied = (await tx.execute(sql`SELECT value FROM meta WHERE key = ${FINDING_ROWS_COPY_MARKER}`)).rows.length > 0;
  const plan = planRowCopy((await tx.execute(sql.raw(copied ? ROW_COPY_READ_STALE : ROW_COPY_READ_ALL))).rows as unknown as RowCopySource[]);
  for (const batch of batches(plan.fingerprints)) {
    await tx.execute(sql`DELETE FROM finding_rows WHERE fingerprint IN (${sql.join(batch.map(fp => sql`${fp}`), sql`, `)})`);
  }
  for (const batch of batches(plan.records)) {
    const values = batch.map(r => sql`(${r.fingerprint}, ${r.position}, ${r.data})`);
    await tx.execute(sql`INSERT INTO finding_rows (fingerprint, position, data) VALUES ${sql.join(values, sql`, `)}`);
  }
  for (const batch of batches(plan.findings)) {
    const values = batch.map(f => sql`(${f.fingerprint}::text, ${f.rowCount}::integer, ${f.rowsScanId}::text)`);
    await tx.execute(sql`UPDATE findings SET row_count = v.row_count, rows_scan_id = v.rows_scan_id
      FROM (VALUES ${sql.join(values, sql`, `)}) AS v(fingerprint, row_count, rows_scan_id)
      WHERE findings.fingerprint = v.fingerprint`);
  }
  if (plan.fingerprints.length > 0) {
    const mismatch = rowCopyMismatch(plan, (await tx.execute(sql.raw(ROW_COPY_READ_BACK))).rows as unknown as RowRecord[]);
    if (mismatch) throw new Error(`the copy did not match: ${mismatch}`);
  }
  await tx.execute(sql.raw(ROW_COPY_DELETE_ORPHANS));
  if (!copied) {
    await tx.execute(sql`INSERT INTO meta (key, value) VALUES (${FINDING_ROWS_COPY_MARKER}, ${new Date().toISOString()}) ON CONFLICT (key) DO NOTHING`);
  }
}

/** The Postgres half of migrate.ts's buildColumnCatalogue(): the same build and the same proof, once,
 *  and only after the rows copy has proved out. A throw rolls the savepoint back. */
async function buildColumnCatalogue(tx: PgTx): Promise<void> {
  if ((await tx.execute(sql`SELECT value FROM meta WHERE key = ${COLUMN_CATALOGUE_MARKER}`)).rows.length > 0) return;
  if ((await tx.execute(sql`SELECT value FROM meta WHERE key = ${FINDING_ROWS_COPY_MARKER}`)).rows.length === 0) return;
  const planned: CatalogueRecord[] = [];
  for (const { rule_id } of (await tx.execute(sql.raw(CATALOGUE_READ_RULES))).rows as unknown as { rule_id: string }[]) {
    const rows = (await tx.execute(sql`SELECT r.data AS data FROM finding_rows r JOIN findings f ON f.fingerprint = r.fingerprint WHERE f.rule_id = ${rule_id}`)).rows as unknown as { data: string }[];
    const collector = new PathCollector();
    for (const row of rows) collector.add(row.data);
    for (const path of collector.result()) planned.push({ rule_id, path });
  }
  await tx.execute(sql`DELETE FROM column_catalogue`);
  for (const batch of batches(planned)) {
    const values = batch.map(p => sql`(${p.rule_id}, ${p.path})`);
    await tx.execute(sql`INSERT INTO column_catalogue (rule_id, path) VALUES ${sql.join(values, sql`, `)}`);
  }
  const mismatch = catalogueMismatch(planned, (await tx.execute(sql.raw(CATALOGUE_READ_BACK))).rows as unknown as CatalogueRecord[]);
  if (mismatch) throw new Error(`the build did not match: ${mismatch}`);
  await tx.execute(sql`INSERT INTO meta (key, value) VALUES (${COLUMN_CATALOGUE_MARKER}, ${new Date().toISOString()}) ON CONFLICT (key) DO NOTHING`);
}
