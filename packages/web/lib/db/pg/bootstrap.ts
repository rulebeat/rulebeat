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
 * DDL mirrors `schema.pg.ts` exactly; see that file for why timestamps and JSON stay TEXT.
 *
 * Spike scope (issue #73 Phase 0): only the tables the spiked repositories touch. Seeding
 * (categories, built-in rules, dashboards) arrives with Phase 1.
 */
const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
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

CREATE TABLE IF NOT EXISTS finding_events (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  category TEXT NOT NULL,
  scan_id TEXT NOT NULL,
  type TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

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
`;

export async function bootstrapPg(db: NodePgDatabase<typeof pgSchema>): Promise<void> {
  await db.execute(sql.raw(DDL));
}
