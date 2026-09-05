import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';

export const rules = sqliteTable('rules', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  category: text('category').notNull(),
  severity: text('severity').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  scope: text('scope').notNull(),             // JSON: RuleScope
  resourceTypes: text('resource_types').notNull(), // JSON: string[]
  filter: text('filter'),                     // JSON: Condition[] | null (legacy; migrated into conditions on read)
  conditions: text('conditions').notNull(),   // JSON: Condition[]
  projectColumns: text('project_columns'),    // JSON: string[] | null → use DEFAULT_PROJECT_COLUMNS when absent
  rawKql: text('raw_kql'),                    // optional raw KQL override; when set + conditions empty → every row is a finding
  conditionGroups: text('condition_groups'),  // JSON: ConditionGroup[] | null — when set, takes precedence over conditions
  type: text('type').notNull().default('custom'), // 'builtin' | 'community' | 'custom' — same concept as Azure Policy's policyType
  pack: text('pack'),                         // named pack for built-ins (e.g. 'rulebeat-core')
  queryBackend: text('query_backend').notNull().default('resource-graph'), // 'resource-graph' | 'microsoft-graph' | 'log-analytics'
  graphQuery: text('graph_query'),            // JSON: GraphQuery | null — set only when queryBackend = 'microsoft-graph'
  logsQuery: text('logs_query'),              // JSON: LogAnalyticsQuery | null — set only when queryBackend = 'log-analytics'
  shape: text('shape').notNull().default('detect'),       // 'detect' | 'assert' — 'assert' when applies_to is set (spec 031), else 'detect'
  kind: text('kind').notNull().default('state'),          // 'state' | 'activity' — always derived from queryBackend, never authored
  group: text('group_name'),                  // optional user-defined group name (column: group_name avoids SQL reserved word)
  tags: text('tags'),                         // JSON: string[] | null — multi-dimensional labels
  visualQuery: text('visual_query'),          // JSON: VisualQuery | null — visual builder state; rawKql stores the generated KQL
  appliesTo: text('applies_to'),              // JSON: VisualQuery | null — spec 031 population/count query; presence drives shape='assert'
  lastRunStatus: text('last_run_status'),     // RuleExecutionStatus | null — this rule's outcome the last time a scan actually ran it
  lastRunAt: text('last_run_at'),             // ISO timestamp of that outcome; null = never run
  lastPopulationCount: integer('last_population_count'), // spec 031: Applies-to count from the last scan that returned one; null for 'detect' rules or one whose population query has only ever failed
});

export const scans = sqliteTable('scans', {
  id: text('id').primaryKey(),
  module: text('module').notNull(),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at').notNull(),
  durationMs: integer('duration_ms').notNull(),
  subscriptionsScanned: text('subscriptions_scanned').notNull(), // JSON: string[]
  findings: text('findings').notNull(),     // JSON: Finding[]
  counts: text('counts').notNull(),         // JSON: Record<Severity, number>
  totalRules: integer('total_rules').notNull().default(0),
  triggeredBy: text('triggered_by').notNull().default('manual'), // 'manual' | 'schedule'
  scheduleId: text('schedule_id'),
  runId: text('run_id'), // links back to schedule_runs.id (the execution that produced this category's scan)
  coverage: text('coverage').notNull().default('complete'), // 'complete' | 'partial'
  incompleteRules: text('incomplete_rules').notNull().default('[]'), // JSON: IncompleteRule[]
});

export const suppressions = sqliteTable('suppressions', {
  id: text('id').primaryKey(),
  fingerprint: text('fingerprint').notNull(),
  resourceId: text('resource_id'), // nullable: absent for a suppressed 'activity' finding pattern (spec 034)
  reason: text('reason').notNull(),
  suppressedAt: text('suppressed_at').notNull(),
  expiresAt: text('expires_at'),
});

export const schemaCache = sqliteTable('schema_cache', {
  resourceType: text('resource_type').primaryKey(),
  fields: text('fields').notNull(),         // JSON: string[]
  cachedAt: text('cached_at').notNull(),
  fieldCount: integer('field_count').notNull(),
});

export const resourceTypesCache = sqliteTable('resource_types_cache', {
  id: integer('id').primaryKey(),           // always 1
  types: text('types').notNull(),           // JSON: string[]
  cachedAt: text('cached_at').notNull(),
});

export const dashboards = sqliteTable('dashboards', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  config: text('config').notNull(),         // JSON: DashboardConfig
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
});

export const categories = sqliteTable('categories', {
  id: text('id').primaryKey(),              // slug, e.g. 'compliance'
  label: text('label').notNull(),
  color: text('color'),
  icon: text('icon'),
  sortOrder: integer('sort_order').notNull().default(0),
  isBuiltin: integer('is_builtin', { mode: 'boolean' }).notNull().default(false),
  // is_special stays physically in SQLite (spec 029, Codex's accepted CHEAPER PATH) — this
  // Drizzle definition just stops declaring it. Nothing reads or writes the orphaned column.
  createdAt: text('created_at').notNull(),
});

export const schedules = sqliteTable('schedules', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),

  // Target: what gets scanned
  targetType: text('target_type').notNull().default('all'),   // 'all' | 'categories' | 'tags' | 'rules'
  targetValues: text('target_values').notNull().default('[]'), // JSON: string[] — category slugs, tag names, or rule ids

  // Recurrence (Outlook-style structured pattern, not raw cron):
  recurrenceType: text('recurrence_type').notNull().default('once'), // 'once' | 'hourly' | 'daily' | 'weekly' | 'monthly'
  interval: integer('interval').notNull().default(1),          // every N hours/days/weeks/months (unused for 'once')
  daysOfWeek: text('days_of_week'),                            // JSON: number[] (0=Sun..6=Sat), weekly only
  dayOfMonth: integer('day_of_month'),                          // 1-31, monthly only (clamped to month length)
  startAt: text('start_at').notNull(),                          // ISO datetime — anchors date, time-of-day, and interval alignment

  endType: text('end_type').notNull().default('never'),        // 'never' | 'on_date'
  endDate: text('end_date'),                                    // ISO date, when endType = 'on_date'

  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  nextRunAt: text('next_run_at'),             // UTC ISO; null when disabled or recurrence exhausted
  lastRunAt: text('last_run_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const meta = sqliteTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

// Local role assignment. Keyed on the Entra object id (`oid`) once known, but a row can exist
// with oid = null: an admin can assign a role by email before that person has ever signed in,
// and the oid gets linked on their first sign-in (matched on lowercased email).
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),                  // lowercased; UNIQUE enforced in the raw DDL
  oid: text('oid'),                                // Entra object id — null until first sign-in
  name: text('name'),                              // display name, filled in on first sign-in
  role: text('role').notNull().default('viewer'),  // 'admin' | 'editor' | 'viewer'
  scope: text('scope'),                            // JSON: reserved for scoped roles — always null today
  // Bumped by any local-password mutation (self-service change, admin set/reset/remove) to
  // invalidate every outstanding JWT for this account — see spec 020. A token's `epoch` claim must
  // match this value or getCurrentUser() treats the session as signed out.
  sessionEpoch: integer('session_epoch').notNull().default(0),
  createdAt: text('created_at').notNull(),
  lastSeenAt: text('last_seen_at'),
});

// The Azure service principal RuleBeat scans with, when it was entered in the UI rather than
// supplied as an environment variable. Modelled as a table rather than a handful of `meta` keys so
// that scanning more than one tenant later is a new row, not a migration — the same shape Prowler
// and CloudQuery use for a "provider" record.
//
// `clientSecret` holds ciphertext, never the secret itself (see lib/secret-box.ts). Environment
// variables always win over any row here, so an IaC or Marketplace deployment arrives configured
// and never shows a setup screen.
export const azureCredentials = sqliteTable('azure_credentials', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),                        // display label, e.g. "Contoso production"
  tenantId: text('tenant_id').notNull(),
  clientId: text('client_id').notNull(),
  clientSecret: text('client_secret').notNull(),       // AES-256-GCM ciphertext — never plaintext
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  lastVerifiedAt: text('last_verified_at'),            // UTC ISO of the last successful live check
  lastVerifiedSubscriptions: integer('last_verified_subscriptions'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  createdBy: text('created_by'),                       // actor email, for the same reason audit_log denormalizes it
});

// The default Log Analytics workspace RuleBeat queries for `queryBackend: 'log-analytics'` rules
// (spec 035). Same shape as azureCredentials above but with no secret of its own — a workspace query
// is authorized by the existing Azure credential (Log Analytics Reader on the workspace), not a
// separate identity. `isActive` mirrors azureCredentials: at most one row active, environment always
// wins over it.
export const logAnalyticsWorkspaces = sqliteTable('log_analytics_workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),                        // display label, e.g. "Contoso production LAW"
  workspaceId: text('workspace_id').notNull(),          // the workspace GUID queried via /v1/workspaces/{id}
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  lastVerifiedAt: text('last_verified_at'),            // UTC ISO of the last successful live check
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  createdBy: text('created_by'),                       // actor email, for the same reason audit_log denormalizes it
});

// A local username/password credential for a user row. Break-glass by design: an admin sets one
// so someone can always get in even if SSO is misconfigured or down. `user_id` is the primary
// key rather than a separate id column because a user has at most one local password.
export const localAccounts = sqliteTable('local_accounts', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  passwordHash: text('password_hash').notNull(),
  mustChangePassword: integer('must_change_password', { mode: 'boolean' }).notNull().default(false),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntil: text('locked_until'),
  passwordUpdatedAt: text('password_updated_at'),
  createdAt: text('created_at').notNull(),
});

// A single-sign-on provider configured through Settings → Sign-in, the console-configurable
// counterpart to azureCredentials above — same shape, same reasoning (a table rather than a
// handful of meta keys, so a second provider or a second tenant later is a new row). Only one is
// ever active. `isActive` defaults false: a saved row is unverified until a real sign-in succeeds
// through it, so a typo'd tenant or a wrong redirect URI never silently becomes "the" way in.
export const ssoProviders = sqliteTable('sso_providers', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),                 // 'microsoft-entra-id' today; extensible
  tenantId: text('tenant_id').notNull(),
  clientId: text('client_id').notNull(),
  clientSecret: text('client_secret').notNull(),         // AES-256-GCM ciphertext — never plaintext
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(false),
  lastVerifiedAt: text('last_verified_at'),              // set on the first real sign-in through it
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  createdBy: text('created_by'),
});

export const auditLog = sqliteTable('audit_log', {
  id: text('id').primaryKey(),
  actorId: text('actor_id').notNull(),
  actorEmail: text('actor_email').notNull(), // denormalized — the log stays readable after the user row is removed
  action: text('action').notNull(),          // AuditAction, e.g. 'rule.update'
  entityType: text('entity_type'),           // 'rule' | 'suppression' | 'schedule' | 'category' | 'dashboard' | 'user' | 'scan' | 'auth'
  entityId: text('entity_id'),
  summary: text('summary').notNull(),        // human-readable one-liner
  details: text('details'),                  // JSON: Record<string, unknown> — changed field NAMES, never their values
  occurredAt: text('occurred_at').notNull(),
});

export const findings = sqliteTable('findings', {
  fingerprint: text('fingerprint').primaryKey(),   // sha256(ruleId::resourceId).slice(0,16), or sha256(ruleId::activity::dimensionKey) for kind:'activity'
  ruleId: text('rule_id').notNull(),
  category: text('category').notNull(),            // slug at last sighting
  severity: text('severity').notNull(),
  // 'state' (default) = a resource currently misconfigured, has resourceId/Type/Name below.
  // 'activity' (spec 034) = a recurring occurrence with no resource to point at; resourceId/Type/Name
  // are null and dimensionKey carries what makes the occurrence distinct instead. Never derived from
  // anything but the source Finding.kind — see Rule.kind's deriveKind() for the rule-level analog.
  kind: text('kind').notNull().default('state'),   // 'state' | 'activity'
  dimensionKey: text('dimension_key'),             // set only for kind:'activity'
  resourceId: text('resource_id'),
  resourceType: text('resource_type'),
  resourceName: text('resource_name'),
  subscriptionId: text('subscription_id').notNull(),
  resourceGroup: text('resource_group'),
  location: text('location'),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  recommendation: text('recommendation').notNull().default(''),
  remediationSteps: text('remediation_steps').notNull().default('[]'), // JSON
  evidence: text('evidence').notNull().default('{}'),                  // JSON, latest sighting
  azurePortalLink: text('azure_portal_link'),
  status: text('status').notNull().default('active'),                  // 'active' | 'fixed' — an 'activity' finding stays 'active' forever; it ages out of a read-time window instead, never transitions to 'fixed'
  firstSeenAt: text('first_seen_at').notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
  resolvedAt: text('resolved_at'),
  lastScanId: text('last_scan_id'),
  timesSeen: integer('times_seen').notNull().default(1),
});

export const findingEvents = sqliteTable('finding_events', {
  id: text('id').primaryKey(),
  fingerprint: text('fingerprint').notNull(),
  ruleId: text('rule_id').notNull(),
  category: text('category').notNull(),
  scanId: text('scan_id').notNull(),
  type: text('type').notNull(),          // 'created' | 'reactivated' | 'resolved' | 'occurred' (spec 034, activity findings)
  occurredAt: text('occurred_at').notNull(),
});

export const postureSnapshots = sqliteTable('posture_snapshots', {
  category: text('category').notNull(),
  subscriptionId: text('subscription_id').notNull().default(''), // '' = aggregate row (all subscriptions); non-empty = per-subscription breakdown
  date: text('date').notNull(),                              // 'YYYY-MM-DD' UTC
  posturePct: integer('posture_pct'),                         // null when total_rules = 0
  passingRules: integer('passing_rules').notNull().default(0),
  totalRules: integer('total_rules').notNull().default(0),
  unknownRules: integer('unknown_rules').notNull().default(0),       // zero findings but lastRunStatus wasn't a proven 'success' (or never run) — neither passing nor failing
  activityRuleCount: integer('activity_rule_count').notNull().default(0), // 'activity'-kind rules enabled for this category, excluded from totalRules entirely
  // 1 = pre-spec-030 (possibly backfilled) posture formula, 2 = honest spec-030 formula — lets a
  // baseline comparison exclude rows it can't honestly compare against (spec 033).
  formulaVersion: integer('formula_version').notNull().default(1),
  activeFindings: integer('active_findings').notNull().default(0),
  severityCounts: text('severity_counts').notNull().default('{}'), // JSON Record<Severity, number>
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.category, table.subscriptionId, table.date] }),
}));

// Despite the name (kept for migration simplicity), this table is now the general "runs" record
// for BOTH scheduled and manual (ad-hoc "Run Scan") executions — scheduleId is '' for manual runs
// rather than a nullable column, avoiding a NOT NULL relaxation that would need a table rebuild.
// Outbound notification channels — one row per destination (Teams Workflows URL, Slack incoming
// webhook, generic webhook, or SMTP email). The URL/secret is AES-256-GCM ciphertext.
// For webhook types: `url` = the webhook URL. For email: `url` = the SMTP password (may be empty
// for anonymous relays). Non-secret email config (host, port, etc.) lives in `config` as JSON.
// Severity threshold and scope live on the per-schedule junction table — this table is an address
// book. `lastError` surfaces delivery failures in the UI.
export const notificationChannels = sqliteTable('notification_channels', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(),            // 'teams' | 'slack' | 'webhook' | 'email'
  url: text('url').notNull(),              // AES-256-GCM ciphertext — never plaintext
  config: text('config'),                  // JSON: EmailChannelConfig — null for non-email channels
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  lastNotifiedAt: text('last_notified_at'),
  lastError: text('last_error'),
});

// Per-schedule notification assignments. Each row means "when scheduleId runs, post to channelId
// if new findings meet minSeverity AND (when set) match the category/subscription scope."
// null categoryIds = all categories; null subscriptionIds = all subscriptions.
// Deleting a schedule cascades here via deleteLinksForSchedule().
export const scheduleNotificationChannels = sqliteTable('schedule_notification_channels', {
  scheduleId: text('schedule_id').notNull(),
  channelId: text('channel_id').notNull(),
  minSeverity: text('min_severity').notNull().default('high'),
  categoryIds: text('category_ids'),       // JSON: string[] | null — null = all categories
  subscriptionIds: text('subscription_ids'), // JSON: string[] | null — null = all subscriptions
}, (table) => ({
  pk: primaryKey({ columns: [table.scheduleId, table.channelId] }),
}));

export const scheduleRuns = sqliteTable('schedule_runs', {
  id: text('id').primaryKey(),
  scheduleId: text('schedule_id').notNull(), // '' for manual (non-scheduled) runs
  triggeredBy: text('triggered_by').notNull().default('schedule'), // 'manual' | 'schedule'
  targetType: text('target_type'),   // ScheduleTargetType — null for pre-migration rows
  targetValues: text('target_values'), // JSON: string[] — null for pre-migration rows
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at'),
  status: text('status').notNull(),           // 'running' | 'success' | 'partial' | 'error'
  categories: text('categories').notNull(),   // JSON: string[] as resolved at run time
  totalFindings: integer('total_findings').notNull().default(0),
  newFindings: integer('new_findings').notNull().default(0),
  newFindingFingerprints: text('new_finding_fingerprints'), // JSON: string[]
  error: text('error'),
  durationMs: integer('duration_ms'),
  notifyStatus: text('notify_status').notNull().default('none'), // 'none' | 'pending' | 'sending' | 'sent'
  // Overlap safety (issue #88). Two RuleBeat processes can share one database for the length of a
  // rolling deploy, so a row has to say which process owns it and whether that process is still
  // alive; null on every row written before these columns existed, which recovery reads as stale.
  notifyClaimedAt: text('notify_claimed_at'), // when the current 'sending' claim was taken
  heartbeatAt: text('heartbeat_at'),          // last proof of life from the process running this row
  ownerId: text('owner_id'),                  // lib/instance-id.ts's per-process id
});

// One row per delivery attempt sequence (a channel's final outcome for a single run, after retries
// are exhausted) — the history behind the single-value lastNotifiedAt/lastError columns on
// notificationChannels, which get overwritten on every dispatch. No SQL-level FK (matches every
// other table in this schema); deleteChannel() cascades here by hand.
export const notificationDeliveries = sqliteTable('notification_deliveries', {
  id: text('id').primaryKey(),
  channelId: text('channel_id').notNull(),
  scheduleId: text('schedule_id').notNull(),
  runId: text('run_id').notNull(),
  occurredAt: text('occurred_at').notNull(),
  ok: integer('ok', { mode: 'boolean' }).notNull(),              // 0/1
  attempts: integer('attempts').notNull().default(1),
  httpStatus: integer('http_status'),
  error: text('error'),
  findingsCount: integer('findings_count').notNull().default(0),
});

// A query composed on the /query page (spec 037) that a user chose to keep. First per-user-owned
// data in this schema: 'private' visibility is visible only to owner_id and is hand-cascade-deleted
// alongside them (see deleteUser()); 'shared' is visible to every editor/admin and survives its
// owner's deletion — owner_email stays denormalized for display once that happens, same reasoning
// as actor_email on auditLog. No SQL-level FK, matching every other table in this schema.
export const savedQueries = sqliteTable('saved_queries', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  queryBackend: text('query_backend').notNull(), // 'resource-graph' | 'microsoft-graph' | 'log-analytics'
  scope: text('scope'),                // JSON: RuleScope | null — resource-graph only
  visualQuery: text('visual_query'),   // JSON: VisualQuery | null
  rawKql: text('raw_kql'),
  graphQuery: text('graph_query'),     // JSON: GraphQuery | null
  logsQuery: text('logs_query'),       // JSON: LogAnalyticsQuery | null
  visibility: text('visibility').notNull().default('private'), // 'private' | 'shared'
  ownerId: text('owner_id').notNull(),
  ownerEmail: text('owner_email').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  lastRunAt: text('last_run_at'),
});

// Recent run history for the live query page (spec 037 follow-up — descoped to sessionStorage at
// ship time, moved server-side once real use showed people wanted it to survive a refresh/device).
// Always fully personal, unlike savedQueries — there is no 'shared' visibility, so deleteUser()
// removes every row outright rather than only a 'private' subset. No SQL-level FK, matching every
// other table in this schema.
export const queryRuns = sqliteTable('query_runs', {
  id: text('id').primaryKey(),
  queryBackend: text('query_backend').notNull(), // 'resource-graph' | 'microsoft-graph' | 'log-analytics'
  scope: text('scope'),                // JSON: RuleScope | null — resource-graph only
  rawKql: text('raw_kql'),             // resource-graph only — the run routes never receive visualQuery
  graphQuery: text('graph_query'),     // JSON: GraphQuery | null
  logsQuery: text('logs_query'),       // JSON: LogAnalyticsQuery | null
  count: integer('count').notNull(),
  capped: integer('capped', { mode: 'boolean' }).notNull(),
  truncated: integer('truncated', { mode: 'boolean' }).notNull(),
  savedQueryId: text('saved_query_id'),
  ownerId: text('owner_id').notNull(),
  ranAt: text('ran_at').notNull(),
});
