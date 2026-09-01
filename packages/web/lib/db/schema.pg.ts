import { pgTable, text, integer, boolean, bigserial, primaryKey } from 'drizzle-orm/pg-core';

/**
 * The Postgres twin of `schema.ts`, column-for-column identical in names and nullability.
 *
 * It differs from the SQLite twin only where the dialect forces it:
 *  - booleans are real `boolean` columns instead of `integer({ mode: 'boolean' })`;
 *  - `notification_deliveries` gains a `seq` bigserial as the insertion-order tiebreak, because
 *    Postgres has no implicit `rowid` (SQLite keeps using its rowid, unchanged);
 *  - everything else stays `text`, deliberately. Timestamps remain ISO text compared
 *    lexicographically and JSON remains text through the same JSON.parse/stringify mappers, so
 *    ordering semantics and row mappers are byte-identical across both backends. Do not "upgrade"
 *    these to timestamptz/jsonb.
 *
 * Spike scope (issue #73 Phase 0): only the tables the three spiked repositories touch. The
 * remaining tables arrive with Phase 1.
 */

export const meta = pgTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const categories = pgTable('categories', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  color: text('color'),
  icon: text('icon'),
  sortOrder: integer('sort_order').notNull().default(0),
  isBuiltin: boolean('is_builtin').notNull().default(false),
  createdAt: text('created_at').notNull(),
});

export const findings = pgTable('findings', {
  fingerprint: text('fingerprint').primaryKey(),
  ruleId: text('rule_id').notNull(),
  category: text('category').notNull(),
  severity: text('severity').notNull(),
  kind: text('kind').notNull().default('state'),
  dimensionKey: text('dimension_key'),
  resourceId: text('resource_id'),
  resourceType: text('resource_type'),
  resourceName: text('resource_name'),
  subscriptionId: text('subscription_id').notNull(),
  resourceGroup: text('resource_group'),
  location: text('location'),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  recommendation: text('recommendation').notNull().default(''),
  remediationSteps: text('remediation_steps').notNull().default('[]'),
  evidence: text('evidence').notNull().default('{}'),
  azurePortalLink: text('azure_portal_link'),
  status: text('status').notNull().default('active'),
  firstSeenAt: text('first_seen_at').notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
  resolvedAt: text('resolved_at'),
  lastScanId: text('last_scan_id'),
  timesSeen: integer('times_seen').notNull().default(1),
});

export const findingEvents = pgTable('finding_events', {
  id: text('id').primaryKey(),
  fingerprint: text('fingerprint').notNull(),
  ruleId: text('rule_id').notNull(),
  category: text('category').notNull(),
  scanId: text('scan_id').notNull(),
  type: text('type').notNull(),
  occurredAt: text('occurred_at').notNull(),
});

export const postureSnapshots = pgTable('posture_snapshots', {
  category: text('category').notNull(),
  subscriptionId: text('subscription_id').notNull().default(''),
  date: text('date').notNull(),
  posturePct: integer('posture_pct'),
  passingRules: integer('passing_rules').notNull().default(0),
  totalRules: integer('total_rules').notNull().default(0),
  unknownRules: integer('unknown_rules').notNull().default(0),
  activityRuleCount: integer('activity_rule_count').notNull().default(0),
  formulaVersion: integer('formula_version').notNull().default(1),
  activeFindings: integer('active_findings').notNull().default(0),
  severityCounts: text('severity_counts').notNull().default('{}'),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.category, table.subscriptionId, table.date] }),
}));

export const notificationChannels = pgTable('notification_channels', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  url: text('url').notNull(),
  config: text('config'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  lastNotifiedAt: text('last_notified_at'),
  lastError: text('last_error'),
});

export const notificationDeliveries = pgTable('notification_deliveries', {
  id: text('id').primaryKey(),
  /** Postgres-only insertion-order tiebreak, standing in for SQLite's implicit rowid. */
  seq: bigserial('seq', { mode: 'number' }).notNull(),
  channelId: text('channel_id').notNull(),
  scheduleId: text('schedule_id').notNull(),
  runId: text('run_id').notNull(),
  occurredAt: text('occurred_at').notNull(),
  ok: boolean('ok').notNull(),
  attempts: integer('attempts').notNull().default(1),
  httpStatus: integer('http_status'),
  error: text('error'),
  findingsCount: integer('findings_count').notNull().default(0),
});
