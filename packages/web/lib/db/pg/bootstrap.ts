import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as pgSchema from '../schema.pg';

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
  shape TEXT NOT NULL DEFAULT 'detect',
  kind TEXT NOT NULL DEFAULT 'state',
  group_name TEXT,
  tags TEXT,
  visual_query TEXT,
  applies_to TEXT,
  last_run_status TEXT,
  last_run_at TEXT,
  last_population_count INTEGER
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
  times_seen INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_findings_category_status ON findings(category, status);
CREATE INDEX IF NOT EXISTS idx_findings_rule ON findings(rule_id);

CREATE TABLE IF NOT EXISTS finding_events (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  category TEXT NOT NULL,
  scan_id TEXT NOT NULL,
  type TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_finding_events_time ON finding_events(occurred_at DESC);

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
  last_error TEXT
);

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
  owner_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule ON schedule_runs(schedule_id, started_at DESC);
-- Overlap safety (issue #88), for a Postgres database bootstrapped before these columns shipped.
ALTER TABLE schedule_runs ADD COLUMN IF NOT EXISTS notify_claimed_at TEXT;
ALTER TABLE schedule_runs ADD COLUMN IF NOT EXISTS heartbeat_at TEXT;
ALTER TABLE schedule_runs ADD COLUMN IF NOT EXISTS owner_id TEXT;

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
  });
}
