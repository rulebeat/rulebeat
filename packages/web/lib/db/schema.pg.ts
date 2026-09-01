import { pgTable, text, integer, boolean, bigserial, primaryKey } from 'drizzle-orm/pg-core';

/**
 * The Postgres twin of `schema.ts`, column-for-column identical in names and nullability.
 *
 * It differs from the SQLite twin only where the dialect forces it:
 *  - booleans are real `boolean` columns instead of `integer({ mode: 'boolean' })`;
 *  - `notification_deliveries`, `saved_queries` and `query_runs` gain a `seq` bigserial as the
 *    insertion-order tiebreak, because Postgres has no implicit `rowid` (SQLite keeps using its
 *    rowid, unchanged);
 *  - `categories` has no `is_special` column: that orphaned column exists physically in SQLite
 *    installs only and is not declared in the Drizzle twin either;
 *  - everything else stays `text`, deliberately. Timestamps remain ISO text compared
 *    lexicographically and JSON remains text through the same JSON.parse/stringify mappers, so
 *    ordering semantics and row mappers are byte-identical across both backends. Do not "upgrade"
 *    these to timestamptz/jsonb.
 *
 * The executable DDL lives in `pg/bootstrap.ts` and must mirror this file exactly.
 */

export const rules = pgTable('rules', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  category: text('category').notNull(),
  severity: text('severity').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  scope: text('scope').notNull(),
  resourceTypes: text('resource_types').notNull(),
  filter: text('filter'),
  conditions: text('conditions').notNull(),
  projectColumns: text('project_columns'),
  rawKql: text('raw_kql'),
  conditionGroups: text('condition_groups'),
  type: text('type').notNull().default('custom'),
  pack: text('pack'),
  queryBackend: text('query_backend').notNull().default('resource-graph'),
  graphQuery: text('graph_query'),
  logsQuery: text('logs_query'),
  shape: text('shape').notNull().default('detect'),
  kind: text('kind').notNull().default('state'),
  group: text('group_name'),
  tags: text('tags'),
  visualQuery: text('visual_query'),
  appliesTo: text('applies_to'),
  lastRunStatus: text('last_run_status'),
  lastRunAt: text('last_run_at'),
  lastPopulationCount: integer('last_population_count'),
});

export const scans = pgTable('scans', {
  id: text('id').primaryKey(),
  module: text('module').notNull(),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at').notNull(),
  durationMs: integer('duration_ms').notNull(),
  subscriptionsScanned: text('subscriptions_scanned').notNull(),
  findings: text('findings').notNull(),
  counts: text('counts').notNull(),
  totalRules: integer('total_rules').notNull().default(0),
  triggeredBy: text('triggered_by').notNull().default('manual'),
  scheduleId: text('schedule_id'),
  runId: text('run_id'),
  coverage: text('coverage').notNull().default('complete'),
  incompleteRules: text('incomplete_rules').notNull().default('[]'),
});

export const suppressions = pgTable('suppressions', {
  id: text('id').primaryKey(),
  fingerprint: text('fingerprint').notNull(),
  resourceId: text('resource_id'),
  reason: text('reason').notNull(),
  suppressedAt: text('suppressed_at').notNull(),
  expiresAt: text('expires_at'),
});

export const schemaCache = pgTable('schema_cache', {
  resourceType: text('resource_type').primaryKey(),
  fields: text('fields').notNull(),
  cachedAt: text('cached_at').notNull(),
  fieldCount: integer('field_count').notNull(),
});

export const resourceTypesCache = pgTable('resource_types_cache', {
  id: integer('id').primaryKey(), // always 1; CHECK (id = 1) enforced in the bootstrap DDL
  types: text('types').notNull(),
  cachedAt: text('cached_at').notNull(),
});

export const dashboards = pgTable('dashboards', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  config: text('config').notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: text('created_at').notNull(),
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

export const schedules = pgTable('schedules', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  targetType: text('target_type').notNull().default('all'),
  targetValues: text('target_values').notNull().default('[]'),
  recurrenceType: text('recurrence_type').notNull().default('once'),
  interval: integer('interval').notNull().default(1),
  daysOfWeek: text('days_of_week'),
  dayOfMonth: integer('day_of_month'),
  startAt: text('start_at').notNull(),
  endType: text('end_type').notNull().default('never'),
  endDate: text('end_date'),
  enabled: boolean('enabled').notNull().default(true),
  nextRunAt: text('next_run_at'),
  lastRunAt: text('last_run_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const meta = pgTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  oid: text('oid').unique(),
  name: text('name'),
  role: text('role').notNull().default('viewer'),
  scope: text('scope'),
  sessionEpoch: integer('session_epoch').notNull().default(0),
  createdAt: text('created_at').notNull(),
  lastSeenAt: text('last_seen_at'),
});

export const azureCredentials = pgTable('azure_credentials', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  tenantId: text('tenant_id').notNull(),
  clientId: text('client_id').notNull(),
  clientSecret: text('client_secret').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  lastVerifiedAt: text('last_verified_at'),
  lastVerifiedSubscriptions: integer('last_verified_subscriptions'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  createdBy: text('created_by'),
});

export const logAnalyticsWorkspaces = pgTable('log_analytics_workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  workspaceId: text('workspace_id').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  lastVerifiedAt: text('last_verified_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  createdBy: text('created_by'),
});

export const localAccounts = pgTable('local_accounts', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  passwordHash: text('password_hash').notNull(),
  mustChangePassword: boolean('must_change_password').notNull().default(false),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntil: text('locked_until'),
  passwordUpdatedAt: text('password_updated_at'),
  createdAt: text('created_at').notNull(),
});

export const ssoProviders = pgTable('sso_providers', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  tenantId: text('tenant_id').notNull(),
  clientId: text('client_id').notNull(),
  clientSecret: text('client_secret').notNull(),
  isActive: boolean('is_active').notNull().default(false),
  lastVerifiedAt: text('last_verified_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  createdBy: text('created_by'),
});

export const auditLog = pgTable('audit_log', {
  id: text('id').primaryKey(),
  actorId: text('actor_id').notNull(),
  actorEmail: text('actor_email').notNull(),
  action: text('action').notNull(),
  entityType: text('entity_type'),
  entityId: text('entity_id'),
  summary: text('summary').notNull(),
  details: text('details'),
  occurredAt: text('occurred_at').notNull(),
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

export const scheduleNotificationChannels = pgTable('schedule_notification_channels', {
  scheduleId: text('schedule_id').notNull(),
  channelId: text('channel_id').notNull(),
  minSeverity: text('min_severity').notNull().default('high'),
  categoryIds: text('category_ids'),
  subscriptionIds: text('subscription_ids'),
}, (table) => ({
  pk: primaryKey({ columns: [table.scheduleId, table.channelId] }),
}));

export const scheduleRuns = pgTable('schedule_runs', {
  id: text('id').primaryKey(),
  scheduleId: text('schedule_id').notNull(),
  triggeredBy: text('triggered_by').notNull().default('schedule'),
  targetType: text('target_type'),
  targetValues: text('target_values'),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at'),
  status: text('status').notNull(),
  categories: text('categories').notNull(),
  totalFindings: integer('total_findings').notNull().default(0),
  newFindings: integer('new_findings').notNull().default(0),
  newFindingFingerprints: text('new_finding_fingerprints'),
  error: text('error'),
  durationMs: integer('duration_ms'),
  notifyStatus: text('notify_status').notNull().default('none'),
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

export const savedQueries = pgTable('saved_queries', {
  id: text('id').primaryKey(),
  /** Postgres-only insertion-order tiebreak, standing in for SQLite's implicit rowid. */
  seq: bigserial('seq', { mode: 'number' }).notNull(),
  name: text('name').notNull(),
  queryBackend: text('query_backend').notNull(),
  scope: text('scope'),
  visualQuery: text('visual_query'),
  rawKql: text('raw_kql'),
  graphQuery: text('graph_query'),
  logsQuery: text('logs_query'),
  visibility: text('visibility').notNull().default('private'),
  ownerId: text('owner_id').notNull(),
  ownerEmail: text('owner_email').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  lastRunAt: text('last_run_at'),
});

export const queryRuns = pgTable('query_runs', {
  id: text('id').primaryKey(),
  /** Postgres-only insertion-order tiebreak, standing in for SQLite's implicit rowid. */
  seq: bigserial('seq', { mode: 'number' }).notNull(),
  queryBackend: text('query_backend').notNull(),
  scope: text('scope'),
  rawKql: text('raw_kql'),
  graphQuery: text('graph_query'),
  logsQuery: text('logs_query'),
  count: integer('count').notNull(),
  capped: boolean('capped').notNull(),
  truncated: boolean('truncated').notNull(),
  savedQueryId: text('saved_query_id'),
  ownerId: text('owner_id').notNull(),
  ranAt: text('ran_at').notNull(),
});
