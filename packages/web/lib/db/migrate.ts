import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
// Sub-path import, not the package root: this keeps the Azure SDK out of the database layer's
// import graph. `finding.js` needs only node's crypto.
import { computeFingerprint } from '@rulebeat/core/finding';
import { buildRuleQuery, type Rule } from '@rulebeat/core/kql';
import { BUILTIN_RULES } from '../builtin-rules';
import { STARTER_DASHBOARD } from '../dashboard-templates';
import { hashPasswordSync } from '../password';

/**
 * Everything the app does to a database file on startup, in the order it does it.
 *
 * This was lifted out of `client.ts` unchanged so it can be run against a database other than the
 * live one — which is the only way to test it. `client.ts` still calls these in the same order at
 * import time, so the product's behaviour is identical; what changed is that the upgrade is now
 * something you can point at a sample file.
 *
 * Two properties worth preserving if this is ever edited:
 *
 *  - **Order is load-bearing.** A `RENAME COLUMN` must precede the `ADD COLUMN` that would otherwise
 *    create the same name and strand the old column's data. This has gone wrong once already and
 *    cost a column's worth of user data; see docs/engineering/conventions/data.md.
 *  - **The swallowed errors are deliberate but blunt.** `try { … } catch {}` is how an
 *    already-applied step skips harmlessly, and also how a genuine failure goes unnoticed. Tests in
 *    `tests/unit/db-migrations*.test.ts` exist because the code itself cannot tell you which happened.
 */

interface RenameOptions {
  /**
   * Rewrite references to `oldId` even when no rule carries it any more.
   *
   * Only safe when the *new* id is fixed and known to be seeded — the built-in and pack renames. The
   * legacy-slug renames mint a fresh `crypto.randomUUID()` per run, so rewriting a reference there
   * would swap a stale pointer for a dangling one.
   */
  rewriteOrphanedReferences?: boolean;
}

/**
 * Moves a rule's findings, events and suppressions onto the fingerprint its new id produces.
 *
 * A finding is identified by `sha256(ruleId::resourceId)`, recomputed from scratch on every scan. So
 * when a rule's id changes and the stored fingerprints are left alone, the next scan derives
 * different ones: existing findings are never matched again (their age and history stranded), the
 * same violations are all reported as brand new, and — worst — **every suppression silently stops
 * suppressing**, because suppressions are keyed on the fingerprint alone. An accepted risk would
 * start alerting again with nothing to indicate why. See RB-QA-013.
 *
 * Matching is exact, never inferred: a row is only rewritten when its stored fingerprint really is
 * the one `oldId` would have produced for that resource. Anything else is left untouched.
 * Suppressions have no `rule_id` column, which is why they are matched this way rather than by rule.
 */
function remapFingerprints(sqlite: Database.Database, oldId: string, newId: string): void {
  const updateFinding = sqlite.prepare(`UPDATE findings SET fingerprint = ? WHERE fingerprint = ?`);
  const updateEvents = sqlite.prepare(`UPDATE finding_events SET fingerprint = ? WHERE fingerprint = ?`);
  const updateSuppression = sqlite.prepare(`UPDATE suppressions SET fingerprint = ? WHERE fingerprint = ?`);

  const remap = (resourceId: string, storedFingerprint: string): void => {
    if (computeFingerprint(oldId, resourceId) !== storedFingerprint) return;
    const next = computeFingerprint(newId, resourceId);
    if (next === storedFingerprint) return;
    // Each in its own try/catch: `findings.fingerprint` is a primary key, so a row already sitting
    // at the new value (from an interrupted earlier run) must not abort the remaining rewrites.
    try { updateFinding.run(next, storedFingerprint); } catch { /* collision — leave it */ }
    try { updateEvents.run(next, storedFingerprint); } catch { /* collision — leave it */ }
    try { updateSuppression.run(next, storedFingerprint); } catch { /* collision — leave it */ }
  };

  try {
    const findings = sqlite
      .prepare(`SELECT fingerprint, resource_id FROM findings WHERE rule_id = ?`)
      .all(oldId) as { fingerprint: string; resource_id: string }[];
    for (const f of findings) remap(f.resource_id, f.fingerprint);
  } catch { /* table may not exist on very old databases */ }

  try {
    const suppressions = sqlite
      .prepare(`SELECT fingerprint, resource_id FROM suppressions`)
      .all() as { fingerprint: string; resource_id: string }[];
    for (const s of suppressions) remap(s.resource_id, s.fingerprint);
  } catch { /* table may not exist */ }
}

/** Opens a database with the pragmas the product runs with. Tests must use this, not `new Database`. */
export function openDatabase(dbPath: string): Database.Database {
  const sqlite = new Database(dbPath);
  // SQLite allows exactly one writer at a time; without this, a second process that opens the
  // same file while the first is mid-migration/seed gets an immediate SQLITE_BUSY instead of
  // waiting a moment for the lock to clear (see seedDefaultDashboard/seedOwnerAccount below for
  // why more than one process can legitimately race to open this file). 5000 wasn't enough on its
  // own: with three of Next's page-data-collection workers racing through the full
  // migration+seed sequence at once (each its own handful of IMMEDIATE transactions), the last
  // worker can still be queued behind the other two for longer than 5s on CI's slower storage,
  // so it hit SQLITE_BUSY instead of just waiting its turn. First statement on the connection,
  // ahead of the WAL pragma: setting a timeout takes no locks itself, and everything after this
  // line can need one.
  sqlite.pragma('busy_timeout = 30000');
  // The busy timeout does NOT cover the rollback-to-WAL conversion this pragma performs on a
  // brand-new file. Converting needs the file's exclusive lock, and when two fresh processes
  // race the conversion, the loser is holding a shared lock the winner needs gone while wanting
  // a write lock the winner already claimed. SQLite resolves that the only way it can, by
  // returning SQLITE_BUSY to the loser immediately, busy handler deliberately bypassed (measured
  // at 4ms with a 30s timeout armed). That immediate throw out of `openDatabase` was the
  // intermittent `next build` failure in the Docker builder (#51): whichever page-data worker
  // lost the conversion race to the brand-new database died on its import of client.ts, taking
  // the whole build with it.
  //
  // So SQLITE_BUSY from this one pragma is retried, not surfaced. A failed attempt holds no
  // locks, the winner's conversion completes in milliseconds, and a later attempt finds the file
  // already in WAL, which makes the pragma a no-op that needs no exclusive lock at all. The
  // deadline mirrors the busy timeout above; any other error, and SQLITE_BUSY past the deadline,
  // still throw.
  const walDeadline = Date.now() + 30_000;
  for (;;) {
    try {
      sqlite.pragma('journal_mode = WAL');
      break;
    } catch (err) {
      if ((err as { code?: string }).code !== 'SQLITE_BUSY' || Date.now() >= walDeadline) throw err;
      // Synchronous on purpose: openDatabase runs at module scope. Jitter keeps two losers from
      // retrying in lockstep.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 + Math.floor(Math.random() * 40));
    }
  }
  sqlite.pragma('foreign_keys = ON');
  // On a brand-new, still-empty database file, `journal_mode = WAL` above does not create the
  // `-wal` sidecar: SQLite has no existing page-1 header to convert yet, so it defers that until
  // the first write. A fresh install's very first writes are the migrations and the initial admin
  // seed that follow this call, which would land in a `-wal` file created after
  // restrictDbFilePermissions() below already ran and found nothing to chmod. This throwaway write
  // forces the sidecar to exist first, so the secrets those writes carry are never briefly exposed
  // at default (world-readable) permissions.
  if (dbPath !== ':memory:') {
    // IF NOT EXISTS / IF EXISTS on both statements, not just the create: two processes opening
    // the same brand-new file at once (Next's parallel page-data-collection workers at build time
    // are the reproducible case) can otherwise have one drop the table a moment before the other
    // gets to, which throws "no such table" on the unconditional DROP.
    sqlite.exec('CREATE TABLE IF NOT EXISTS __rulebeat_wal_bootstrap (x); DROP TABLE IF EXISTS __rulebeat_wal_bootstrap;');
  }
  restrictDbFilePermissions(dbPath);
  return sqlite;
}

/**
 * Best-effort `0600` on the db file and its `-wal`/`-shm` sidecars — no-op on Windows, same
 * `try {} catch {}` shape already used for `auth.key`/`encryption.key`/`initial-password.txt`
 * elsewhere in this file. Runs on every open, not just first creation, so an upgrade from an older
 * RuleBeat version tightens permissions on its existing database the next time it starts. The
 * throwaway write above guarantees the `-wal` sidecar (and, on some SQLite builds, `-shm`) already
 * exists by the time this runs; each is still guarded by `existsSync` rather than assumed.
 */
function restrictDbFilePermissions(dbPath: string): void {
  if (dbPath === ':memory:') return;
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      if (existsSync(path)) chmodSync(path, 0o600);
    } catch {
      /* best effort */
    }
  }
}

/** Brings a database of any past shape up to the current schema. Safe to run repeatedly. */
export function runMigrations(sqlite: Database.Database): void {
  // ── One-time table rename: policies → rules (existing DBs) ───────────────────
  // If the old 'policies' table exists and 'rules' does not, rename it. Idempotent: once 'rules'
  // exists this is a no-op, and if 'policies' never existed it skips silently.
  //
  // This MUST run before the CREATE TABLE block below. It used to sit after it, where its own guard
  // could never pass — `CREATE TABLE IF NOT EXISTS rules` had already created an empty `rules`, so
  // `!hasRules` was always false, the rename never fired, and every rule an install of that vintage
  // owned stayed orphaned in a table nothing reads. See RB-QA-009.
  try {
    const hasPolicies = (sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='policies'`).get() as { name: string } | undefined)?.name;
    const hasRules = (sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='rules'`).get() as { name: string } | undefined)?.name;
    if (hasPolicies && !hasRules) {
      sqlite.exec(`ALTER TABLE policies RENAME TO rules`);
    }
  } catch { /* skip */ }

  // Create tables if they don't exist (new installs).
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS rules (
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
      project_columns TEXT
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
      triggered_by TEXT NOT NULL DEFAULT 'manual',
      schedule_id TEXT,
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
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      color TEXT,
      icon TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_builtin INTEGER NOT NULL DEFAULT 0,
      is_special INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schedules (
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

    CREATE TABLE IF NOT EXISTS compliance_snapshots (
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
    CREATE INDEX IF NOT EXISTS idx_snapshots_date ON compliance_snapshots(date DESC);

    CREATE TABLE IF NOT EXISTS schedule_runs (
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
    CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule ON schedule_runs(schedule_id, started_at DESC);

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

    CREATE TABLE IF NOT EXISTS azure_credentials (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      client_secret TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
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
      is_active INTEGER NOT NULL DEFAULT 1,
      last_verified_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT
    );

    CREATE TABLE IF NOT EXISTS local_accounts (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      password_hash TEXT NOT NULL,
      must_change_password INTEGER NOT NULL DEFAULT 0,
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
      is_active INTEGER NOT NULL DEFAULT 0,
      last_verified_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT
    );

    CREATE TABLE IF NOT EXISTS notification_channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      url TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_notified_at TEXT,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS schedule_notification_channels (
      schedule_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      min_severity TEXT NOT NULL DEFAULT 'high',
      PRIMARY KEY (schedule_id, channel_id)
    );

    CREATE TABLE IF NOT EXISTS notification_deliveries (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      schedule_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      ok INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 1,
      http_status INTEGER,
      error TEXT,
      findings_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_notification_deliveries_channel
      ON notification_deliveries(channel_id, occurred_at DESC);

    CREATE TABLE IF NOT EXISTS saved_queries (
      id TEXT PRIMARY KEY,
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
      query_backend TEXT NOT NULL,
      scope TEXT,
      raw_kql TEXT,
      graph_query TEXT,
      logs_query TEXT,
      count INTEGER NOT NULL,
      capped INTEGER NOT NULL,
      truncated INTEGER NOT NULL,
      saved_query_id TEXT,
      owner_id TEXT NOT NULL,
      ran_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_query_runs_owner ON query_runs(owner_id, ran_at DESC);
  `);

  // Drop columns that moved from notification_channels to schedule_notification_channels.
  // Idempotent: SQLite allows DROP COLUMN since 3.35.0; the try/catch handles "no such column".
  try { sqlite.exec(`ALTER TABLE notification_channels DROP COLUMN min_severity`); } catch { /* already gone or never existed */ }
  try { sqlite.exec(`ALTER TABLE notification_channels DROP COLUMN enabled`); } catch { /* already gone or never existed */ }

  // C1a: email channel config (non-secret fields stored as JSON; SMTP password remains in `url`).
  try { sqlite.exec(`ALTER TABLE notification_channels ADD COLUMN config TEXT`); } catch { /* already exists */ }

  // C1b: per-channel category/subscription scope on the junction table.
  try { sqlite.exec(`ALTER TABLE schedule_notification_channels ADD COLUMN category_ids TEXT`); } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE schedule_notification_channels ADD COLUMN subscription_ids TEXT`); } catch { /* already exists */ }

  // Recover from a rebuild that was interrupted (crash, container restart, power cut) partway
  // through the CREATE → INSERT → DROP → RENAME below. Two states can be left on disk, and neither
  // heals itself:
  //
  //  - `compliance_snapshots_new` exists *and* the old table still does. The rebuild retries, its
  //    CREATE hits a table that already exists, and the whole script aborts into the catch — on
  //    every start, forever, while snapshot writes keep failing against the old key.
  //  - `compliance_snapshots_new` exists and the old table does not, because the DROP landed. The
  //    CREATE TABLE IF NOT EXISTS above then recreated the live table empty and *in the new shape*,
  //    so the guard below sees nothing to do and every day of trend history is quietly abandoned in
  //    the leftover table.
  //
  // See RB-QA-011.
  try {
    const scaffolding = sqlite.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='compliance_snapshots_new'`,
    ).get();
    if (scaffolding) {
      const liveHasSub = sqlite.prepare(
        `SELECT name FROM pragma_table_info('compliance_snapshots') WHERE name = 'subscription_id'`,
      ).get();
      const live = sqlite.prepare(`SELECT COUNT(*) AS n FROM compliance_snapshots`).get() as { n: number };
      const staged = sqlite.prepare(`SELECT COUNT(*) AS n FROM compliance_snapshots_new`).get() as { n: number };

      if (liveHasSub && live.n === 0 && staged.n > 0) {
        // The DROP had landed: the staged copy holds the only surviving history.
        sqlite.exec(`
          INSERT OR IGNORE INTO compliance_snapshots
            (category, subscription_id, date, compliance_pct, passing_rules, total_rules, active_findings, severity_counts, updated_at)
          SELECT category, subscription_id, date, compliance_pct, passing_rules, total_rules, active_findings, severity_counts, updated_at
          FROM compliance_snapshots_new;
        `);
      }
      // Either way the staged table has served its purpose; the rebuild below starts clean.
      sqlite.exec(`DROP TABLE IF EXISTS compliance_snapshots_new`);
    }
  } catch { /* best-effort */ }

  // Phase 5 dashboard refinement: compliance_snapshots needs one row per (category, subscription,
  // date) instead of one per (category, date), so trend/delta survive a subscription filter.
  // SQLite can't alter a primary key in place, so existing installs get a full table rebuild;
  // fresh installs already get the new shape from the CREATE TABLE above, so this is a no-op there.
  //
  // Run as one transaction so an interruption rolls back to the pre-rebuild state rather than
  // leaving a half-built table for the recovery above to clean up.
  try {
    const hasSubscriptionCol = sqlite.prepare(
      `SELECT name FROM pragma_table_info('compliance_snapshots') WHERE name = 'subscription_id'`,
    ).get();
    if (!hasSubscriptionCol) {
      const rebuild = sqlite.transaction(() => {
        sqlite.exec(`
        CREATE TABLE compliance_snapshots_new (
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
        INSERT INTO compliance_snapshots_new
          (category, subscription_id, date, compliance_pct, passing_rules, total_rules, active_findings, severity_counts, updated_at)
        SELECT category, '', date, compliance_pct, passing_rules, total_rules, active_findings, severity_counts, updated_at
        FROM compliance_snapshots;
        DROP TABLE compliance_snapshots;
        ALTER TABLE compliance_snapshots_new RENAME TO compliance_snapshots;
        CREATE INDEX IF NOT EXISTS idx_snapshots_date ON compliance_snapshots(date DESC);
      `);
      });
      rebuild();
    }
  } catch { /* best-effort */ }

  // spec 030: honest compliance metric — a rule with zero findings only counts as passing if its
  // last run proved it, so the snapshot needs to record what didn't fit either side of that split.
  try { sqlite.exec(`ALTER TABLE compliance_snapshots ADD COLUMN unknown_rules INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE compliance_snapshots ADD COLUMN activity_rule_count INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }

  // spec 033: marks which compliance formula wrote each row, so a baseline comparison can exclude
  // rows it can't honestly compare against (the "-75% vs baseline" bug) — every row written before
  // this column existed defaults to 1 (pre-spec-030), same reasoning as unknown_rules above.
  try { sqlite.exec(`ALTER TABLE compliance_snapshots ADD COLUMN formula_version INTEGER NOT NULL DEFAULT 1`); } catch { /* already exists */ }

  // Renames the generic "compliance" metric to "posture" everywhere outside the Compliance category
  // itself (dev-phase rename, no real installs yet) — RENAME first, same ordering reasoning as
  // rules.source → rules.type below: a fresh ADD COLUMN fallback would otherwise create an empty
  // posture_pct column and strand the real numbers under the old name.
  //
  // The CREATE TABLE IF NOT EXISTS compliance_snapshots near the top of this file can't know the
  // table was ever renamed away, so once the rename below has succeeded a single time, that
  // statement starts recreating an empty compliance_snapshots on every later startup — the name is
  // free again as far as IF NOT EXISTS is concerned. posture_snapshots already existing is proof the
  // rename already ran for real, so any compliance_snapshots sitting next to it here is that
  // resurrected empty shell, not data — drop it before the rename runs again so it can't collide
  // with posture_snapshots and get left stranded under the old name forever.
  try {
    const alreadyRenamed = sqlite.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='posture_snapshots'`,
    ).get();
    if (alreadyRenamed) sqlite.exec(`DROP TABLE IF EXISTS compliance_snapshots`);
  } catch { /* best-effort */ }
  try { sqlite.exec(`ALTER TABLE compliance_snapshots RENAME TO posture_snapshots`); } catch { /* already renamed or doesn't exist */ }
  try { sqlite.exec(`ALTER TABLE posture_snapshots RENAME COLUMN compliance_pct TO posture_pct`); } catch { /* already renamed or doesn't exist */ }

  // spec 034: activity findings have no resource to describe, so resource_id/resource_type/
  // resource_name must become nullable on both findings and suppressions. SQLite can't ALTER COLUMN
  // to drop NOT NULL, so existing installs get the same staged-table rebuild compliance_snapshots
  // used above; a fresh install already gets the new shape from the CREATE TABLE IF NOT EXISTS near
  // the top of this file, so hasNotNullResourceId is false there and this is a no-op.
  //
  // Same interrupted-migration hazard as the compliance_snapshots rebuild above (see the long comment
  // there and RB-QA-011): a `findings_new`/`suppressions_new` staging table can survive a crash either
  // with the live table still intact (retry would hit "table already exists") or with the live table
  // already dropped and silently recreated empty in the NEW shape by CREATE TABLE IF NOT EXISTS (which
  // would make the guard below see nothing to do and abandon every finding in the leftover table). Same
  // recovery: if the staged table is non-empty and the live table looks like the new (rebuilt) shape
  // with zero rows, the staged rows are the only survivors — reclaim them, then drop the scaffolding
  // either way so the rebuild below starts clean.
  try {
    const scaffolding = sqlite.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='findings_new'`,
    ).get();
    if (scaffolding) {
      const liveHasKind = sqlite.prepare(
        `SELECT name FROM pragma_table_info('findings') WHERE name = 'kind'`,
      ).get();
      const live = sqlite.prepare(`SELECT COUNT(*) AS n FROM findings`).get() as { n: number };
      const staged = sqlite.prepare(`SELECT COUNT(*) AS n FROM findings_new`).get() as { n: number };
      if (liveHasKind && live.n === 0 && staged.n > 0) {
        sqlite.exec(`
          INSERT OR IGNORE INTO findings
            (fingerprint, rule_id, category, severity, kind, dimension_key, resource_id, resource_type,
             resource_name, subscription_id, resource_group, location, title, description, recommendation,
             remediation_steps, evidence, azure_portal_link, status, first_seen_at, last_seen_at,
             resolved_at, last_scan_id, times_seen)
          SELECT fingerprint, rule_id, category, severity, kind, dimension_key, resource_id, resource_type,
             resource_name, subscription_id, resource_group, location, title, description, recommendation,
             remediation_steps, evidence, azure_portal_link, status, first_seen_at, last_seen_at,
             resolved_at, last_scan_id, times_seen
          FROM findings_new;
        `);
      }
      sqlite.exec(`DROP TABLE IF EXISTS findings_new`);
    }
  } catch { /* best-effort */ }

  try {
    const hasNotNullResourceId = sqlite.prepare(
      `SELECT "notnull" AS n FROM pragma_table_info('findings') WHERE name = 'resource_id'`,
    ).get() as { n: number } | undefined;
    if (hasNotNullResourceId?.n === 1) {
      const rebuild = sqlite.transaction(() => {
        sqlite.exec(`
        CREATE TABLE findings_new (
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
        INSERT INTO findings_new
          (fingerprint, rule_id, category, severity, kind, dimension_key, resource_id, resource_type,
           resource_name, subscription_id, resource_group, location, title, description, recommendation,
           remediation_steps, evidence, azure_portal_link, status, first_seen_at, last_seen_at,
           resolved_at, last_scan_id, times_seen)
        SELECT fingerprint, rule_id, category, severity, 'state', NULL, resource_id, resource_type,
           resource_name, subscription_id, resource_group, location, title, description, recommendation,
           remediation_steps, evidence, azure_portal_link, status, first_seen_at, last_seen_at,
           resolved_at, last_scan_id, times_seen
        FROM findings;
        DROP TABLE findings;
        ALTER TABLE findings_new RENAME TO findings;
        CREATE INDEX IF NOT EXISTS idx_findings_category_status ON findings(category, status);
        CREATE INDEX IF NOT EXISTS idx_findings_rule ON findings(rule_id);
      `);
      });
      rebuild();
    }
  } catch { /* best-effort */ }

  // Same rebuild, same reasoning, for suppressions.resource_id (spec 034) — suppressions are matched
  // purely by fingerprint (see isActiveSuppression()), so resource_id has always been display/audit
  // only; relaxing it to nullable needs no data transformation, just the NOT NULL removal itself.
  try {
    const scaffolding = sqlite.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='suppressions_new'`,
    ).get();
    if (scaffolding) {
      const live = sqlite.prepare(`SELECT COUNT(*) AS n FROM suppressions`).get() as { n: number };
      const staged = sqlite.prepare(`SELECT COUNT(*) AS n FROM suppressions_new`).get() as { n: number };
      if (live.n === 0 && staged.n > 0) {
        sqlite.exec(`
          INSERT OR IGNORE INTO suppressions (id, fingerprint, resource_id, reason, suppressed_at, expires_at)
          SELECT id, fingerprint, resource_id, reason, suppressed_at, expires_at FROM suppressions_new;
        `);
      }
      sqlite.exec(`DROP TABLE IF EXISTS suppressions_new`);
    }
  } catch { /* best-effort */ }

  try {
    const hasNotNullResourceId = sqlite.prepare(
      `SELECT "notnull" AS n FROM pragma_table_info('suppressions') WHERE name = 'resource_id'`,
    ).get() as { n: number } | undefined;
    if (hasNotNullResourceId?.n === 1) {
      const rebuild = sqlite.transaction(() => {
        sqlite.exec(`
        CREATE TABLE suppressions_new (
          id TEXT PRIMARY KEY,
          fingerprint TEXT NOT NULL,
          resource_id TEXT,
          reason TEXT NOT NULL,
          suppressed_at TEXT NOT NULL,
          expires_at TEXT
        );
        INSERT INTO suppressions_new (id, fingerprint, resource_id, reason, suppressed_at, expires_at)
        SELECT id, fingerprint, resource_id, reason, suppressed_at, expires_at FROM suppressions;
        DROP TABLE suppressions;
        ALTER TABLE suppressions_new RENAME TO suppressions;
      `);
      });
      rebuild();
    }
  } catch { /* best-effort */ }

  // Migrations: idempotent column additions on 'rules' table
  try { sqlite.exec(`ALTER TABLE rules ADD COLUMN project_columns TEXT`); } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE rules ADD COLUMN raw_kql TEXT`); } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE rules ADD COLUMN rules_operator TEXT`); } catch { /* already exists */ }
  // Rename source → type (if still named source) before falling back to ADD COLUMN — order
  // matters here: source carries real per-row data (builtin/community/custom), so RENAME must
  // run first or a fresh ADD COLUMN would create an empty 'type' column defaulting every row to
  // 'custom' while the real data sits stranded in the old 'source' column.
  try { sqlite.exec(`ALTER TABLE rules RENAME COLUMN source TO type`); } catch { /* already renamed or doesn't exist */ }
  try { sqlite.exec(`ALTER TABLE rules ADD COLUMN type TEXT NOT NULL DEFAULT 'custom'`); } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE rules ADD COLUMN pack TEXT`); } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE rules ADD COLUMN group_name TEXT`); } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE rules ADD COLUMN visual_query TEXT`); } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE rules ADD COLUMN tags TEXT`); } catch { /* already exists */ }
  // spec 029: rule taxonomy — every pre-existing row is an ARG state-detection rule, which is
  // exactly what these defaults say, so no backfill UPDATE is needed beyond the ALTER itself.
  try { sqlite.exec(`ALTER TABLE rules ADD COLUMN query_backend TEXT NOT NULL DEFAULT 'resource-graph'`); } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE rules ADD COLUMN shape TEXT NOT NULL DEFAULT 'detect'`); } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE rules ADD COLUMN kind TEXT NOT NULL DEFAULT 'state'`); } catch { /* already exists */ }
  // spec 030: last real per-rule scan outcome, so "zero findings" can be told apart from "never
  // successfully ran". Plain nullable columns — every existing row simply hasn't run yet.
  try { sqlite.exec(`ALTER TABLE rules ADD COLUMN last_run_status TEXT`); } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE rules ADD COLUMN last_run_at TEXT`); } catch { /* already exists */ }
  // spec 031: Applies-to population/count query — presence makes a rule's shape 'assert' rather
  // than 'detect'. Absent (the default for every existing row) preserves today's 'detect' exactly.
  try { sqlite.exec(`ALTER TABLE rules ADD COLUMN applies_to TEXT`); } catch { /* already exists */ }
  // spec 031: last population count a scan actually returned — same "nullable, filled in by the
  // next real scan" shape as last_run_status/last_run_at above.
  try { sqlite.exec(`ALTER TABLE rules ADD COLUMN last_population_count INTEGER`); } catch { /* already exists */ }
  // spec 032: Graph query definition — null for every rule except queryBackend = 'microsoft-graph'.
  try { sqlite.exec(`ALTER TABLE rules ADD COLUMN graph_query TEXT`); } catch { /* already exists */ }
  // spec 036: Log Analytics query definition — null for every rule except queryBackend = 'log-analytics'.
  try { sqlite.exec(`ALTER TABLE rules ADD COLUMN logs_query TEXT`); } catch { /* already exists */ }

  // Migrate legacy single-value group_name into the multi-value tags column.
  // Idempotent: once a row's tags are populated, the WHERE clause no longer matches it.
  // group_name is left in place (not dropped) as a rollback-safe vestige.
  sqlite.exec(`
    UPDATE rules SET tags = json_array(group_name)
    WHERE group_name IS NOT NULL AND TRIM(group_name) <> ''
      AND (tags IS NULL OR tags = '' OR tags = '[]');
  `);

  // Rename rule_groups column → condition_groups (if still named rule_groups), then fall back to
  // ADD COLUMN for installs that never had rule_groups at all. Same ordering rule as source → type
  // above, and for the same reason: an ADD COLUMN first makes the RENAME fail with "duplicate column
  // name", which is swallowed, leaving every rule's condition groups stranded in the old column and
  // reading back as empty. That is what used to happen — see RB-QA-010.
  try { sqlite.exec(`ALTER TABLE rules RENAME COLUMN rule_groups TO condition_groups`); } catch { /* already renamed or doesn't exist */ }
  try { sqlite.exec(`ALTER TABLE rules ADD COLUMN condition_groups TEXT`); } catch { /* already exists */ }
  // Rename rules column → conditions (if still named rules — legacy schema)
  try { sqlite.exec(`ALTER TABLE rules RENAME COLUMN rules TO conditions`); } catch { /* already renamed or doesn't exist */ }

  // spec 031: every rule row that predates the current authoring UI can carry only
  // conditions/conditionGroups (or, on the oldest rows, only the legacy filter column — see
  // rowToRule()'s own merge of the two in lib/rules.ts) with no raw_kql at all: a second,
  // independent execution path (buildRuleQuery()) nothing has written to since rule-form.tsx's
  // save() started always sending raw_kql instead. Compile each such row once through the now
  // De-Morgan-corrected buildRuleQuery() and collapse it onto the one representation every rule
  // saved since then already uses. Gated on rows actually missing raw_kql existing, not a
  // one-time marker, so this is a no-op on every startup after the first row migrates.
  const legacyConditionRows = sqlite.prepare(
    `SELECT id, scope, resource_types, filter, conditions, condition_groups, project_columns
     FROM rules WHERE raw_kql IS NULL OR raw_kql = ''`,
  ).all() as {
    id: string;
    scope: string;
    resource_types: string;
    filter: string | null;
    conditions: string | null;
    condition_groups: string | null;
    project_columns: string | null;
  }[];

  if (legacyConditionRows.length > 0) {
    const migrateLegacyConditions = sqlite.prepare(
      `UPDATE rules SET raw_kql = ?, conditions = '[]', condition_groups = NULL WHERE id = ?`,
    );
    for (const row of legacyConditionRows) {
      // Same filter → conditions merge rowToRule() already does at read time, so the compiled
      // KQL matches what a user opening this rule in the UI would already see today.
      const legacyFilterConditions = row.filter ? JSON.parse(row.filter) : [];
      const ownConditions = row.conditions ? JSON.parse(row.conditions) : [];
      // Only the fields buildRuleQuery() actually reads are real; the rest of Rule is irrelevant
      // to compilation and never inspected by it.
      const compileTarget = {
        scope: JSON.parse(row.scope),
        resourceTypes: JSON.parse(row.resource_types),
        conditions: [...legacyFilterConditions, ...ownConditions],
        conditionGroups: row.condition_groups ? JSON.parse(row.condition_groups) : undefined,
        projectColumns: row.project_columns ? JSON.parse(row.project_columns) : undefined,
      } as Rule;
      migrateLegacyConditions.run(buildRuleQuery(compileTarget), row.id);
    }
  }

  // ── One-time column rename: total_policies → total_rules (existing DBs) ──────
  try { sqlite.exec(`ALTER TABLE scans ADD COLUMN total_rules INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE scans ADD COLUMN total_policies INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists (old name) */ }

  // Scheduled scans: provenance columns on existing scans rows
  try { sqlite.exec(`ALTER TABLE scans ADD COLUMN triggered_by TEXT NOT NULL DEFAULT 'manual'`); } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE scans ADD COLUMN schedule_id TEXT`); } catch { /* already exists */ }

  // Unified run history (manual "Run Scan" + scheduled): links a category's scan row back to the
  // schedule_runs execution that produced it. Null for scans triggered via the standalone
  // /api/scan/<category> route (bypasses the run picker) or pre-migration rows.
  try { sqlite.exec(`ALTER TABLE scans ADD COLUMN run_id TEXT`); } catch { /* already exists */ }

  // Scan lifecycle correctness (spec 004): a category's scan can now be 'partial' when one or
  // more rules failed or returned a capped/truncated result — those rules' prior findings were
  // preserved rather than resolved. Existing rows have no stored value and default to 'complete',
  // which is correct: every scan before this migration ran through the old all-or-nothing path.
  try { sqlite.exec(`ALTER TABLE scans ADD COLUMN coverage TEXT NOT NULL DEFAULT 'complete'`); } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE scans ADD COLUMN incomplete_rules TEXT NOT NULL DEFAULT '[]'`); } catch { /* already exists */ }

  // schedule_runs: broaden from schedule-only to a general run record covering manual runs too.
  try { sqlite.exec(`ALTER TABLE schedule_runs ADD COLUMN triggered_by TEXT NOT NULL DEFAULT 'schedule'`); } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE schedule_runs ADD COLUMN target_type TEXT`); } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE schedule_runs ADD COLUMN target_values TEXT`); } catch { /* already exists */ }

  // schedule_runs: durable notification outbox marker (spec 025) — 'none' | 'pending' | 'sent'.
  try { sqlite.exec(`ALTER TABLE schedule_runs ADD COLUMN notify_status TEXT NOT NULL DEFAULT 'none'`); } catch { /* already exists */ }

  // Scheduled scans: replace the first-cut cron-preset model with a structured Outlook-style
  // recurrence + rule/tag/category targeting model. Add the new columns, best-effort-migrate any
  // rows created under the old model (disabling them — the old fields don't map 1:1 onto the new
  // recurrence shape, so migrated rows are surfaced as disabled rather than silently misfiring),
  // then drop the old columns entirely.
  try { sqlite.exec(`ALTER TABLE schedules ADD COLUMN target_type TEXT NOT NULL DEFAULT 'all'`); } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE schedules ADD COLUMN target_values TEXT NOT NULL DEFAULT '[]'`); } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE schedules ADD COLUMN recurrence_type TEXT NOT NULL DEFAULT 'once'`); } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE schedules ADD COLUMN interval INTEGER NOT NULL DEFAULT 1`); } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE schedules ADD COLUMN days_of_week TEXT`); } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE schedules ADD COLUMN day_of_month INTEGER`); } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE schedules ADD COLUMN start_at TEXT NOT NULL DEFAULT ''`); } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE schedules ADD COLUMN end_type TEXT NOT NULL DEFAULT 'never'`); } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE schedules ADD COLUMN end_date TEXT`); } catch { /* already exists */ }

  try {
    const hasOldCronColumn = (sqlite.prepare(`SELECT name FROM pragma_table_info('schedules') WHERE name = 'cron'`).get());
    if (hasOldCronColumn) {
      const legacy = sqlite.prepare(`SELECT id, categories FROM schedules WHERE start_at = '' OR start_at IS NULL`).all() as { id: string; categories: string }[];
      const migrate = sqlite.prepare(`
        UPDATE schedules
        SET target_type = ?, target_values = ?, recurrence_type = 'daily', start_at = ?, enabled = 0, next_run_at = NULL
        WHERE id = ?
      `);
      for (const row of legacy) {
        let cats: string[] = [];
        try { cats = JSON.parse(row.categories) as string[]; } catch { /* malformed — treat as empty */ }
        const isAll = cats.length === 1 && cats[0] === '*';
        migrate.run(isAll ? 'all' : 'categories', isAll ? '[]' : JSON.stringify(cats), new Date().toISOString(), row.id);
      }
    }
  } catch { /* best-effort only */ }

  try { sqlite.exec(`ALTER TABLE schedules DROP COLUMN categories`); } catch { /* already dropped or never existed */ }
  try { sqlite.exec(`ALTER TABLE schedules DROP COLUMN frequency`); } catch { /* already dropped or never existed */ }
  try { sqlite.exec(`ALTER TABLE schedules DROP COLUMN cron`); } catch { /* already dropped or never existed */ }

  // Migrate old module names → category names in scan history
  sqlite.exec(`
    UPDATE scans SET module = 'compliance' WHERE module = 'tags';
    UPDATE scans SET module = 'cost'       WHERE module = 'orphans';
    UPDATE scans SET module = 'security'   WHERE module = 'standards';
    UPDATE scans SET module = 'identity'   WHERE module = 'credentials';
  `);

  // Migrate old ruleId prefixes inside findings JSON → builtin:: equivalents
  sqlite.exec(`
    UPDATE scans SET findings = REPLACE(findings, '"ruleId":"orphan::', '"ruleId":"builtin::orphan-')
      WHERE findings LIKE '%"ruleId":"orphan::%';
    UPDATE scans SET findings = REPLACE(findings, '"ruleId":"standards::', '"ruleId":"builtin::standards-')
      WHERE findings LIKE '%"ruleId":"standards::%';
  `);

  // One-time: rewrite rule ids to plain UUIDs, wherever they still carry a legacy scheme
  // (the 'builtin::<slug>' / 'builtin::aprl-<guid>' prefix, or a hand-typed slug from the old
  // data/policies.json sample seed). Provenance (builtin/community/custom) lives entirely in the
  // `type`/`pack` columns now — the id itself is just an opaque, universally stable identifier,
  // matching every other install that seeds the same builtin/pack data.
  //
  // Each pair is renamed independently (own try/catch) so one bad pair can't abort the rest —
  // seeding runs unconditionally afterward regardless of how far this migration gets, so a
  // silently-aborted loop would otherwise leave every remaining old-format row to be re-seeded
  // as a fresh duplicate under its new id.
  function renameRuleIds(pairs: [string, string][], opts: RenameOptions = {}) {
    const getById = sqlite.prepare(`SELECT id FROM rules WHERE id = ?`);
    const deleteById = sqlite.prepare(`DELETE FROM rules WHERE id = ?`);
    const renameRuleId = sqlite.prepare(`UPDATE rules SET id = ? WHERE id = ?`);
    const renameInFindings = sqlite.prepare(
      `UPDATE scans SET findings = REPLACE(findings, ?, ?) WHERE findings LIKE ?`,
    );
    const renameInDashboards = sqlite.prepare(
      `UPDATE dashboards SET config = REPLACE(config, ?, ?) WHERE config LIKE ?`,
    );
    const renameInFindingsTable = sqlite.prepare(`UPDATE findings SET rule_id = ? WHERE rule_id = ?`);
    const renameInFindingEvents = sqlite.prepare(`UPDATE finding_events SET rule_id = ? WHERE rule_id = ?`);

    for (const [oldId, newId] of pairs) {
      try {
        const oldExists = !!getById.get(oldId);
        // Nothing to rename, but references elsewhere may still point at the old id — see the
        // rewriteOrphanedReferences note on RenameOptions.
        if (!oldExists && !opts.rewriteOrphanedReferences) continue;

        if (oldExists) {
          // A row already sitting at newId means a previous partial run re-seeded a fresh
          // duplicate before this pair got renamed. The old row holds any real user state
          // (enabled/tags/etc.) — keep it, drop the auto-seeded stand-in, then rename.
          if (getById.get(newId)) deleteById.run(newId);
          renameRuleId.run(newId, oldId);
        }

        // Fingerprints first: they are derived from the *old* id, so they have to be remapped
        // before the rows carrying them are re-pointed at the new one.
        remapFingerprints(sqlite, oldId, newId);

        const oldQuoted = `"${oldId}"`;
        const newQuoted = `"${newId}"`;
        renameInFindings.run(oldQuoted, newQuoted, `%${oldQuoted}%`);
        renameInDashboards.run(oldQuoted, newQuoted, `%${oldQuoted}%`);
        renameInFindingsTable.run(newId, oldId);
        renameInFindingEvents.run(newId, oldId);
      } catch { /* ignore this pair, continue with the rest */ }
    }
  }

  try {
    const BUILTIN_ID_RENAMES: [string, string][] = [
      ['builtin::orphan-unattached-disk', '7a25444f-90c1-4c4e-b6dc-3076a857dfa8'],
      ['builtin::orphan-unattached-nic', '75e36a3a-4c4c-4ca2-b7d9-624d1350cb7a'],
      ['builtin::orphan-unused-public-ip', '4bc476d2-2030-4c24-9d67-9b434cf5d80b'],
      ['builtin::orphan-empty-nsg', 'c4ecd795-6e77-4038-9382-9dab237d4953'],
      ['builtin::orphan-stale-snapshot', '8c6c0195-ccb1-41c6-aeb2-1de96df20cc5'],
      ['builtin::standards-storage-https', '9c6d51b9-5bf9-480c-9932-555f339f5e95'],
      ['builtin::standards-storage-public-blob', '18d9a934-c953-4833-ae75-9f169688f360'],
      ['builtin::standards-storage-min-tls', '7a6e836a-11eb-491b-b362-c9751d15b76c'],
      ['builtin::standards-kv-soft-delete', '3bf741b6-a340-41f8-bfb2-c094a85ef575'],
      ['builtin::standards-kv-purge-protection', 'b138e30b-6d3e-4464-a58e-0b46d1d6be21'],
      ['builtin::tag-environment', 'db175338-5c33-484a-bcf5-24f20e3bc60c'],
      ['builtin::tag-owner', 'ba4b3116-7403-4b13-95ae-283272f763c5'],
      ['builtin::tag-costcenter', '74773874-6c41-47b7-b33b-4d6feb8e1031'],
    ];

    // Any remaining APRL rows still on the old 'builtin::aprl-<guid>' scheme rename
    // programmatically (new id = the upstream guid with the prefix stripped).
    const staleAprl = sqlite.prepare(
      `SELECT id FROM rules WHERE pack = 'aprl-v2' AND id LIKE 'builtin::aprl-%'`,
    ).all() as { id: string }[];

    // These targets are fixed and always seeded, so references are worth rewriting even where the
    // rule row itself is long gone — otherwise scan history from the oldest lineage keeps an id
    // that resolves to nothing and drill-through goes nowhere (RB-QA-012).
    renameRuleIds([
      ...BUILTIN_ID_RENAMES,
      ...staleAprl.map((row): [string, string] => [row.id, row.id.replace('builtin::aprl-', '')]),
    ], { rewriteOrphanedReferences: true });
  } catch { /* ignore */ }

  // Installs that started before data/policies.json was removed may have these 4 sample rows
  // seeded with hand-typed slug ids instead of a UUID — bring them in line with every other
  // custom rule (which has always gotten a crypto.randomUUID() id at creation).
  try {
    renameRuleIds([
      ['tag-required-environment', crypto.randomUUID()],
      ['tag-environment-valid-values', crypto.randomUUID()],
      ['tag-required-costcenter', crypto.randomUUID()],
      ['tag-required-owner', crypto.randomUUID()],
    ]);
  } catch { /* ignore */ }

  // spec 020: session-invalidation counter. Existing rows default to 0, matching a token with no
  // epoch claim at all (treated as 0 in getCurrentUser()) — an upgrade never mass-invalidates
  // every current session.
  try { sqlite.exec(`ALTER TABLE users ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }
}

/**
 * Seeds built-in content. Runs on every startup, not just the first: built-in rules and categories
 * are re-asserted with INSERT OR IGNORE. Rules pair that with an UPDATE that backfills engine-owned
 * fields (name/pack/raw_kql) but never touches anything a user edits. Categories used to pair it with
 * an UPDATE that overwrote label/color/icon on every startup — silently reverting any customization
 * in Settings — and now only resyncs sort_order/is_builtin for the same reason.
 *
 * `dataDir` is required rather than defaulted — it decides whether pack rules and legacy JSON get
 * seeded at all, and a default would let a caller inherit `process.cwd()` without noticing.
 *
 * `skipOwnerBootstrap` exists for exactly one caller: `lib/db/client.ts`'s own module-scope call,
 * which — unlike every test fixture in tests/fixtures/upgrade.ts — cannot control `dataDir`
 * (it's a fixed, non-overridable `<cwd>/data`, deliberately, so pack/schema seeding still reads
 * the real committed files under test). Every one of the ~10 test files that imports any
 * repository imports `client.ts` transitively and would otherwise write a real
 * `initial-password.txt` into that real directory on every run. The upgrade-suite fixtures call
 * `runMigrations`/`runSeeds` directly against their own throwaway `dataDir` and are unaffected.
 */
export function runSeeds(sqlite: Database.Database, dataDir: string, opts: { skipOwnerBootstrap?: boolean } = {}): void {
  // Seed from legacy JSON files on first run (one-time migration)
  seedFromJson();
  // Seed built-in rules on every startup (INSERT OR IGNORE preserves user edits; UPDATE backfills name/pack)
  seedBuiltinRules();
  // Seed external pack rules from data/packs/*.json (committed, version-pinned)
  seedPackRules();
  // Seed built-in categories on every startup (INSERT OR IGNORE preserves user edits)
  seedCategories();
  // Seed the default dashboard if none exist
  seedDefaultDashboard();
  // Decide, once, whether this install should see the onboarding wizard — "zero users exist" is the
  // only reliable way to tell a brand-new install from an upgrade, so this MUST run before
  // seedOwnerAccount() below, which creates the first user. Same ordering-is-load-bearing class as
  // the source→type / rule_groups→condition_groups RENAME-before-ADD-COLUMN fix (RB-QA-010): get the
  // order wrong and every existing customer's admin would be a "brand-new install" too.
  seedOnboardingState();
  // A brand-new install has no users at all — create a local admin account so there is a way in
  // without touching env vars. Must run before seedInitialAdmin() so that function's "zero admins"
  // gate no-ops here and stays purely a recovery path for an install that already has users.
  if (!opts.skipOwnerBootstrap) seedOwnerAccount();
  // Ensure someone can administer this install
  seedInitialAdmin();

  function seedFromJson() {
    // suppressions
    const suppressionsFile = join(dataDir, 'suppressions.json');
    const suppressionsEmpty = sqlite.prepare('SELECT COUNT(*) as n FROM suppressions').get() as { n: number };
    if (suppressionsEmpty.n === 0 && existsSync(suppressionsFile)) {
      try {
        const raw = JSON.parse(readFileSync(suppressionsFile, 'utf-8')) as Record<string, unknown>[];
        const insert = sqlite.prepare(`
          INSERT OR IGNORE INTO suppressions (id, fingerprint, resource_id, reason, suppressed_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        const insertMany = sqlite.transaction((rows: Record<string, unknown>[]) => {
          for (const s of rows) {
            insert.run(s.id, s.fingerprint, s.resourceId, s.reason, s.suppressedAt, s.expiresAt ?? null);
          }
        });
        // .immediate(): see seedDefaultDashboard()/seedOwnerAccount() below for why a deferred
        // transaction isn't enough under concurrent build-time workers.
        insertMany.immediate(raw);
      } catch { /* ignore */ }
    }

    // scans (one JSON file per module in data/scans/)
    const scansDir = join(dataDir, 'scans');
    const scansEmpty = sqlite.prepare('SELECT COUNT(*) as n FROM scans').get() as { n: number };
    if (scansEmpty.n === 0 && existsSync(scansDir)) {
      try {
        const insert = sqlite.prepare(`
          INSERT OR IGNORE INTO scans (id, module, started_at, finished_at, duration_ms, subscriptions_scanned, findings, counts)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const insertMany = sqlite.transaction((rows: Record<string, unknown>[]) => {
          for (const s of rows) {
            insert.run(
              crypto.randomUUID(),
              s.module, s.startedAt, s.finishedAt, s.durationMs,
              JSON.stringify(s.subscriptionsScanned ?? []),
              JSON.stringify(s.findings ?? []),
              JSON.stringify(s.counts ?? {}),
            );
          }
        });
        const files = readdirSync(scansDir).filter(f => f.endsWith('.json'));
        for (const file of files) {
          const summaries = JSON.parse(readFileSync(join(scansDir, file), 'utf-8')) as Record<string, unknown>[];
          insertMany.immediate(summaries);
        }
      } catch { /* ignore */ }
    }

    // schema_cache
    const schemasDir = join(dataDir, 'schemas');
    const schemaCacheEmpty = sqlite.prepare('SELECT COUNT(*) as n FROM schema_cache').get() as { n: number };
    if (schemaCacheEmpty.n === 0 && existsSync(schemasDir)) {
      try {
        const insert = sqlite.prepare(`
          INSERT OR IGNORE INTO schema_cache (resource_type, fields, cached_at, field_count)
          VALUES (?, ?, ?, ?)
        `);
        const typesFile = join(schemasDir, '__resource-types.json');
        const insertMany = sqlite.transaction((rows: { resourceType: string; fields: string[]; cachedAt: string; fieldCount: number }[]) => {
          for (const e of rows) {
            insert.run(e.resourceType, JSON.stringify(e.fields), e.cachedAt, e.fieldCount);
          }
        });
        const files = readdirSync(schemasDir).filter(f => f.endsWith('.json') && !f.startsWith('__'));
        const entries = files.flatMap(f => {
          try {
            return [JSON.parse(readFileSync(join(schemasDir, f), 'utf-8')) as { resourceType: string; fields: string[]; cachedAt: string; fieldCount: number }];
          } catch { return []; }
        });
        insertMany.immediate(entries);

        if (existsSync(typesFile)) {
          const data = JSON.parse(readFileSync(typesFile, 'utf-8')) as { types: string[]; cachedAt: string };
          sqlite.prepare(`INSERT OR REPLACE INTO resource_types_cache (id, types, cached_at) VALUES (1, ?, ?)`).run(
            JSON.stringify(data.types), data.cachedAt,
          );
        }
      } catch { /* ignore */ }
    }
  }

  // Mirrors deriveKind() in lib/rules.ts — duplicated rather than imported, because lib/rules.ts
  // imports the db client, which imports this file at module scope, and importing back would cycle.
  function deriveKindForSeed(queryBackend: string): 'state' | 'activity' {
    return queryBackend === 'log-analytics' ? 'activity' : 'state';
  }

  function seedBuiltinRules() {
    // Remove legacy orphan:: / standards:: rows superseded by builtin:: equivalents
    sqlite.exec(`DELETE FROM rules WHERE id LIKE 'orphan::%' OR id LIKE 'standards::%'`);

    const insert = sqlite.prepare(`
      INSERT OR IGNORE INTO rules (id, name, description, category, severity, enabled, scope, resource_types, filter, conditions, raw_kql, type, pack, query_backend, shape, kind, graph_query)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // graph_query is deliberately NOT in the unconditional SET list below, unlike every other
    // column here: spec 032 makes a microsoft-graph builtin's graphQuery editable via
    // PUT /api/rules/[id] (the one field on a builtin row the API allows changing besides
    // enabled/tags), so re-asserting the seed default on every startup would silently revert that
    // edit — the same class of bug the categories seed used to have with label/color/icon.
    // COALESCE only fills a genuine NULL (a pre-032 row, or one that has never had a value), then
    // never touches it again once anything — the backfilled default or a user's own edit — is there.
    const update = sqlite.prepare(`
      UPDATE rules SET type = 'builtin', pack = ?, name = ?, raw_kql = ?, query_backend = ?, shape = ?, kind = ?, graph_query = COALESCE(graph_query, ?) WHERE id = ?
    `);
    const seedAll = sqlite.transaction(() => {
      for (const r of BUILTIN_RULES) {
        const queryBackend = r.queryBackend ?? 'resource-graph';
        const shape = r.shape ?? 'detect';
        const kind = r.kind ?? deriveKindForSeed(queryBackend);
        const graphQuery = r.graphQuery ? JSON.stringify(r.graphQuery) : null;
        insert.run(
          r.id, r.name, r.description, r.category, r.severity,
          r.enabled ? 1 : 0,
          JSON.stringify(r.scope),
          JSON.stringify(r.resourceTypes),
          null,
          JSON.stringify(r.conditions),
          r.rawKql ?? null,
          'builtin',
          r.pack ?? 'rulebeat-core',
          queryBackend,
          shape,
          kind,
          graphQuery,
        );
        // Backfill type/pack/name/raw_kql/taxonomy on rows that already existed (INSERT OR IGNORE skips them);
        // graph_query backfills only when null — see the comment on `update` above.
        update.run(r.pack ?? 'rulebeat-core', r.name, r.rawKql ?? null, queryBackend, shape, kind, graphQuery, r.id);
      }
    });
    // .immediate(): see seedDefaultDashboard()/seedOwnerAccount() below for why a deferred
    // transaction isn't enough under concurrent build-time workers.
    seedAll.immediate();
  }

  function seedPackRules() {
    const packsDir = join(dataDir, 'packs');
    if (!existsSync(packsDir)) return;

    const insert = sqlite.prepare(`
      INSERT OR IGNORE INTO rules (id, name, description, category, severity, enabled, scope, resource_types, filter, conditions, raw_kql, type, pack)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const update = sqlite.prepare(`
      UPDATE rules SET name = ?, type = 'builtin', pack = ?, resource_types = ? WHERE id = ?
    `);

    const files = readdirSync(packsDir).filter(f => f.endsWith('.json') && f !== 'pack-manifest.json');
    for (const file of files) {
      try {
        const packRules = JSON.parse(readFileSync(join(packsDir, file), 'utf-8')) as Array<Record<string, unknown>>;
        const seedPack = sqlite.transaction(() => {
          for (const p of packRules) {
            // Pack JSON uses 'rules' field (old name) — read as conditions for backward compat
            const conditions = p.conditions ?? p.rules ?? [];
            insert.run(
              p.id, p.name, p.description, p.category, p.severity,
              p.enabled ? 1 : 0,
              typeof p.scope === 'string' ? p.scope : JSON.stringify(p.scope),
              typeof p.resourceTypes === 'string' ? p.resourceTypes : JSON.stringify(p.resourceTypes ?? []),
              null,
              typeof conditions === 'string' ? conditions : JSON.stringify(conditions),
              p.rawKql ?? null,
              'builtin',
              p.pack ?? null,
            );
            update.run(
              p.name, p.pack ?? null,
              typeof p.resourceTypes === 'string' ? p.resourceTypes : JSON.stringify(p.resourceTypes ?? []),
              p.id,
            );
          }
        });
        seedPack.immediate();
      } catch { /* malformed pack file — skip */ }
    }
  }

  function seedCategories() {
    const BUILTIN_CATEGORIES = [
      { id: 'compliance',  label: 'Compliance',  color: '#3b82f6', icon: 'Tag',        sortOrder: 1, isSpecial: false },
      { id: 'cost',        label: 'Cost',         color: '#f97316', icon: 'Trash2',     sortOrder: 2, isSpecial: false },
      { id: 'security',    label: 'Security',     color: '#0d9488', icon: 'ShieldCheck',sortOrder: 3, isSpecial: false },
      { id: 'identity',    label: 'Identity',     color: '#8b5cf6', icon: 'KeyRound',   sortOrder: 4, isSpecial: true  },
      { id: 'reliability', label: 'Reliability',  color: '#22c55e', icon: 'Activity',   sortOrder: 5, isSpecial: false },
    ];
    // Security's old seeded default, red — red means "something is wrong" everywhere else in the
    // product (severity, destructive actions), so a category permanently flagged red trained people
    // to stop reading the colour as an alarm. Migrated away below, but only for installs that still
    // have the exact untouched old default — an admin who already chose their own colour keeps it.
    const OLD_SECURITY_RED = '#ef4444';

    const insert = sqlite.prepare(`
      INSERT OR IGNORE INTO categories (id, label, color, icon, sort_order, is_builtin, is_special, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `);
    // label/color/icon are user-editable in Settings and must never be reverted by a restart — only
    // sort_order and the is_builtin flag are structural and safe to re-assert on every startup.
    const resync = sqlite.prepare(`
      UPDATE categories SET sort_order = ?, is_builtin = 1 WHERE id = ?
    `);
    const migrateSecurityColor = sqlite.prepare(`
      UPDATE categories SET color = ? WHERE id = 'security' AND color = ?
    `);

    const seedAll = sqlite.transaction(() => {
      const now = new Date().toISOString();
      for (const c of BUILTIN_CATEGORIES) {
        insert.run(c.id, c.label, c.color, c.icon, c.sortOrder, c.isSpecial ? 1 : 0, now);
        resync.run(c.sortOrder, c.id);
      }
      migrateSecurityColor.run(
        BUILTIN_CATEGORIES.find(c => c.id === 'security')!.color,
        OLD_SECURITY_RED,
      );
    });
    // .immediate(): see seedDefaultDashboard()/seedOwnerAccount() below for why a deferred
    // transaction isn't enough under concurrent build-time workers.
    seedAll.immediate();
  }

  // Seeds the starter dashboard on the very first startup only. Gated on a one-time 'meta' marker
  // rather than "table is empty" alone — a user who later deletes every dashboard must never have
  // one silently reappear on the next restart. The marker is set unconditionally at the end, even
  // for installs upgrading from a pre-Phase-3 version that already has dashboard rows
  // (existing.n > 0), so those installs pick up the marker on their next startup without
  // re-seeding a duplicate.
  // Wrapped in an IMMEDIATE transaction (write lock acquired before the marker/count checks run,
  // not after) so two processes that both import this module at nearly the same instant — e.g.
  // Next.js's `next build` page-data-collection workers, which each independently trigger this
  // same import-time seed against the one real data/rulebeat.db — serialize instead of both
  // observing "not seeded yet" and racing an INSERT into the same `id = 'default'` row. `INSERT OR
  // IGNORE` is defense in depth on top of that: `id` is a fixed literal, so even a re-entrant call
  // is naturally idempotent. Kept as a `function` declaration (not `const`) so it stays hoisted —
  // `runSeeds` calls it before this point in the file, same as every other seed function here.
  function seedDefaultDashboard() {
    sqlite.transaction(() => {
      const marker = sqlite.prepare(`SELECT value FROM meta WHERE key = 'dashboards-seeded-v1'`).get();
      if (marker) return;

      const existing = sqlite.prepare('SELECT COUNT(*) as n FROM dashboards').get() as { n: number };
      if (existing.n === 0) {
        sqlite.prepare(`
          INSERT OR IGNORE INTO dashboards (id, name, description, config, is_default, created_at)
          VALUES (?, ?, ?, ?, 1, ?)
        `).run(
          'default',
          STARTER_DASHBOARD.name,
          STARTER_DASHBOARD.description,
          JSON.stringify(STARTER_DASHBOARD.config),
          new Date().toISOString(),
        );
      }

      sqlite.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)`)
        .run('dashboards-seeded-v1', '1');
    }).immediate();
  }

  // Decides, once, whether this install starts the onboarding wizard. Gated on a one-time 'meta'
  // marker (never revisited) rather than "table is empty", matching seedDefaultDashboard()'s
  // dashboards-seeded-v1 shape above — an admin who skips the wizard, or finishes it, must never
  // have it reappear on a later restart.
  //
  // Both branches write: 'pending' for a genuinely brand-new install (no users yet — the only signal
  // this function has, since it must run before seedOwnerAccount() creates the first one), 'skipped'
  // for anything upgrading from a version that predates this feature. A "leave it absent on fresh
  // installs" variant would break on the *second* startup, once the owner account exists and the
  // upgrade branch would fire instead.
  function seedOnboardingState() {
    const marker = sqlite.prepare(`SELECT value FROM meta WHERE key = 'onboarding-v1'`).get();
    if (marker) return;

    const existingUsers = sqlite.prepare(`SELECT COUNT(*) as n FROM users`).get() as { n: number };
    const status: 'pending' | 'skipped' = existingUsers.n === 0 ? 'pending' : 'skipped';
    const state = { status, lastStep: 1, completedAt: null, completedBy: null };

    sqlite.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)`)
      .run('onboarding-v1', JSON.stringify(state));
  }

  // Bootstraps a way into a brand-new install with no environment configuration at all — the
  // Jenkins/Portainer pattern: a generated password to a file and the log, not an unauthenticated
  // first-run form (which mints an admin from a request nobody had to prove they're allowed to
  // make). Gated on "zero users exist" rather than a one-time marker, matching seedInitialAdmin's
  // reasoning below: an install that already has users must never gain a surprise extra admin.
  //
  // The count-then-insert is wrapped in an IMMEDIATE transaction for the same reason as
  // seedDefaultDashboard() above: two processes racing to import this module both seeing
  // "zero users" and both inserting would otherwise crash on the `users.email` UNIQUE constraint
  // (both default to the same admin@rulebeat.local when unset) instead of the second one cleanly
  // no-op'ing. The password-file write and console banner stay outside the transaction and are
  // gated on `created`, so a process that loses the race never writes a password for an account it
  // didn't actually create.
  function seedOwnerAccount() {
    const email = process.env.RULEBEAT_INITIAL_ADMIN?.trim().toLowerCase() || 'admin@rulebeat.local';
    const password = process.env.RULEBEAT_INITIAL_PASSWORD?.trim() || randomBytes(18).toString('base64url');
    const userId = crypto.randomUUID();
    const now = new Date().toISOString();

    const created = sqlite.transaction(() => {
      const existingUsers = sqlite.prepare(`SELECT COUNT(*) as n FROM users`).get() as { n: number };
      if (existingUsers.n > 0) return false;

      sqlite.prepare(`INSERT INTO users (id, email, role, created_at) VALUES (?, ?, 'admin', ?)`)
        .run(userId, email, now);
      sqlite.prepare(`
        INSERT INTO local_accounts (user_id, password_hash, must_change_password, created_at)
        VALUES (?, ?, 1, ?)
      `).run(userId, hashPasswordSync(password), now);
      return true;
    }).immediate();
    if (!created) return;

    const passwordFile = join(dataDir, 'initial-password.txt');
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(passwordFile, `${email}\n${password}\n`, { mode: 0o600 });
      try { chmodSync(passwordFile, 0o600); } catch { /* no-op on Windows */ }
    } catch (err) {
      console.error('[RuleBeat] could not write the initial password file:', err);
    }

    console.log('');
    console.log('==========================================================================');
    console.log('  RuleBeat: no account exists yet. Created one for first sign-in:');
    console.log(`    Email:    ${email}`);
    console.log(`    Password: see ${passwordFile}`);
    console.log('  You will be asked to set a new password on first sign-in.');
    console.log('==========================================================================');
    console.log('');
  }

  // Names the first admin by email via RULEBEAT_INITIAL_ADMIN. The row is created with oid = null;
  // the oid is linked on that person's first sign-in (see the signIn callback in auth.ts).
  //
  // Deliberately gated on "there are currently zero admins" rather than a one-time meta marker, so
  // the env var doubles as the recovery path for a self-hosted install whose only admin was removed
  // or demoted: set it, restart, and access is back. It requires host access, so it can't be abused
  // from inside the app. With the var unset, there is no Entra-side recovery — access comes back
  // through the seeded local owner account instead (see data/initial-password.txt).
  function seedInitialAdmin() {
    const email = process.env.RULEBEAT_INITIAL_ADMIN?.trim().toLowerCase();
    if (!email) return;

    const admins = sqlite.prepare(`SELECT COUNT(*) as n FROM users WHERE role = 'admin'`).get() as { n: number };
    if (admins.n > 0) return;

    try {
      const existing = sqlite.prepare(`SELECT id FROM users WHERE email = ?`).get(email) as { id: string } | undefined;
      if (existing) {
        sqlite.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(existing.id);
      } else {
        sqlite.prepare(`INSERT INTO users (id, email, role, created_at) VALUES (?, ?, 'admin', ?)`)
          .run(crypto.randomUUID(), email, new Date().toISOString());
      }
    } catch { /* email UNIQUE collision — someone already holds this row; leave it alone */ }
  }
}
