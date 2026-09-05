/**
 * TS-25 · upgrade path — does a customer's data survive?
 *
 * The failure this suite exists to prevent is specific and unrecoverable: someone runs RuleBeat for
 * a month, upgrades, and their custom rules, their finding history or their own admin access are
 * gone. Everything else is a bad afternoon; that is a lost customer.
 *
 * So the assertions are all of the form "the content that went in is still there", never "the
 * upgrade didn't throw". The latter is close to worthless here, because nearly every migration step
 * is wrapped in `try { … } catch {}` — a step that fails for a real reason is indistinguishable from
 * one correctly skipped, and nothing is logged either way.
 *
 * Rules are matched by **name** rather than id, because several migrations legitimately rewrite ids.
 * Surviving under a new id is surviving; vanishing is not.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { is } from 'drizzle-orm';
import { SQLiteTable, getTableConfig } from 'drizzle-orm/sqlite-core';
import * as schema from '@/lib/db/schema';
import { buildRuleQuery, type Rule } from '@rulebeat/core';
import { CUSTOM_RULES, SUPPRESSED_RESOURCE_ID, FIXED_DATES, fingerprintFor } from '../fixtures/populate';
import { SHAPES, addUsers, type BuiltShape, type ShapeName } from '../fixtures/db-shapes';
import { makeSample, open, upgradeInProcess, type Sample } from '../fixtures/upgrade';
import { columnsOf, countRows, tableExists } from '../fixtures/dump';
import { readRules, ruleByName, rowsIfPresent } from '../fixtures/inspect';

/**
 * Every table the app's schema declares, with the columns it expects to find. Read from the schema
 * itself rather than a hand-written list, so a table added later is covered without anyone
 * remembering to add it here.
 */
const SCHEMA_TABLES = (Object.values(schema) as unknown[])
  .filter((v): v is SQLiteTable => is(v, SQLiteTable))
  .map(t => {
    const cfg = getTableConfig(t);
    return { table: t, name: cfg.name, columns: cfg.columns.map(c => c.name) };
  });

interface Upgraded {
  sample: Sample;
  sqlite: Database;
  built: BuiltShape;
}

function upgradeShape(shape: ShapeName): Upgraded {
  const sample = makeSample(shape);
  upgradeInProcess(sample);
  return { sample, sqlite: open(sample.file), built: sample.built };
}

// ── Invariants that must hold for every lineage ───────────────────────────────

describe.each(SHAPES)('TS-25 · %s · the upgraded database is usable', shape => {
  let up: Upgraded;
  beforeAll(async () => { up = upgradeShape(shape); });
  afterAll(() => up.sqlite.close());

  it('25-02 · every table the app declares exists, with every column it expects', async () => {
    const missing: string[] = [];
    for (const { name, columns } of SCHEMA_TABLES) {
      if (!tableExists(up.sqlite, name)) { missing.push(`table ${name}`); continue; }
      const actual = new Set(columnsOf(up.sqlite, name));
      for (const c of columns) if (!actual.has(c)) missing.push(`${name}.${c}`);
    }
    // A column in the schema with no matching migration only fails much later, at query time, on a
    // customer's machine. Catching the whole class here is worth more than any single case below.
    expect(missing, 'schema declares these but the upgrade did not produce them').toEqual([]);
  });

  it('25-02 · the app can actually read every table afterwards', async () => {
    const db = drizzle(up.sqlite, { schema });
    const failed: string[] = [];
    for (const { table, name } of SCHEMA_TABLES) {
      try { db.select().from(table).all(); } catch (err) { failed.push(`${name}: ${String(err)}`); }
    }
    expect(failed, 'these tables exist but cannot be queried').toEqual([]);
  });

  it('25-02 · no half-finished migration scaffolding is left behind', async () => {
    expect(tableExists(up.sqlite, 'compliance_snapshots_new')).toBe(false);
  });
});

// ── Per-case data survival ────────────────────────────────────────────────────

/** Shapes that contain user content. `current` starts empty, so it has nothing to preserve. */
const POPULATED = SHAPES.filter(s => s !== 'current');

describe.each(POPULATED)('TS-25 · %s · the data survives', shape => {
  let up: Upgraded;
  beforeAll(async () => { up = upgradeShape(shape); });
  afterAll(() => up.sqlite.close());

  it('25-03 · every rule that went in is still there, exactly once', async () => {
    const after = readRules(up.sqlite);
    const names = after.map(r => r.name);

    const missing = CUSTOM_RULES.map(r => r.name).filter(n => !names.includes(n));
    expect(missing, 'user-authored rules lost by the upgrade').toEqual([]);

    const duplicated = names.filter((n, i) => names.indexOf(n) !== i);
    expect([...new Set(duplicated)], 'rules duplicated by the upgrade').toEqual([]);
  });

  it('25-04 · custom rules keep their logic, their type and their KQL', async () => {
    // populate.ts seeds every custom rule with the same canned legacy conditions/condition_groups,
    // and only includes raw_kql in the INSERT at all for shapes where cols.hasRawKql is true (see
    // RuleColumns there). For a shape that predates raw_kql (policies-era), spec 031's migration
    // (migrate.ts's legacyConditionRows block) compiles that seeded legacy data into raw_kql exactly
    // once and clears the legacy columns — the logic isn't lost, it's relocated. Branch on what the
    // row actually shows rather than the shape's name, so this stays correct for any future shape
    // regardless of which side of that line it falls on.
    const seededConditions = [{ field: 'name', operator: 'startsWith', value: 'x' }];
    const seededConditionGroups = [{ id: 'g1', conditions: [{ field: 'location', operator: 'equals', value: 'westeurope' }] }];

    for (const expected of CUSTOM_RULES) {
      const rule = ruleByName(up.sqlite, expected.name);
      expect(rule, `custom rule "${expected.name}" is gone`).toBeDefined();

      // Still the user's own rule — a seed UPDATE must never reclassify it as built-in, which would
      // make it read-only in the UI and overwritable on the next upgrade.
      expect(rule!.type, `"${expected.name}" changed provenance`).toBe('custom');
      expect(rule!.category).toBe(expected.category);
      expect(rule!.severity).toBe(expected.severity);

      const conditions = JSON.parse(rule!.conditions ?? '[]');
      const conditionGroups = JSON.parse(rule!.conditionGroups ?? 'null');
      const legacyConditionsStillInPlace = conditions.length > 0 || conditionGroups !== null;

      if (legacyConditionsStillInPlace) {
        // This shape already carried its own raw_kql before the upgrade, so the collapse step never
        // touched this row. The query it asks Azure is the whole point of the rule — byte-identical
        // or it is a different check than the one the user wrote.
        expect(rule!.rawKql, `"${expected.name}" KQL changed`).toBe(expected.rawKql);
        expect(conditions, `"${expected.name}" lost its conditions`).toEqual(seededConditions);
        expect(conditionGroups, `"${expected.name}" lost its condition groups`).toEqual(seededConditionGroups);
      } else {
        // This shape predates raw_kql entirely. Compute the expected KQL by calling buildRuleQuery()
        // with the same compileTarget shape migrate.ts's own collapse step builds, rather than
        // hand-typing a KQL string that would drift the moment the compiler's output format changes.
        const expectedKql = buildRuleQuery({
          scope: { level: 'resource' },
          resourceTypes: ['*'],
          conditions: seededConditions,
          conditionGroups: seededConditionGroups,
        } as Rule);
        expect(rule!.rawKql, `"${expected.name}"'s legacy conditions were lost instead of compiled`).toBe(expectedKql);
      }
    }
  });

  it('25-05 · scan history and the finding lifecycle are preserved', async () => {
    const scans = rowsIfPresent(up.sqlite, 'scans');
    expect(scans.length, 'scan history was dropped').toBeGreaterThan(0);

    for (const scan of scans) {
      const findings = JSON.parse(String(scan.findings)) as Record<string, unknown>[];
      expect(findings.length, 'a scan lost its findings').toBeGreaterThan(0);
    }

    if (up.built.findingFingerprints.length === 0) return;

    const findings = rowsIfPresent(up.sqlite, 'findings');
    // Count, not identity: a lineage that rewrites rule ids also rewrites the fingerprints derived
    // from them, deliberately, so that a scan can still recognise these findings afterwards (see
    // RB-QA-013). That each one is *correct* is asserted in db-migrations-integrity.test.ts; here
    // what matters is that none were lost or duplicated.
    expect(findings.length, 'findings were lost or duplicated').toBe(up.built.findingFingerprints.length);
    expect(new Set(findings.map(f => String(f.fingerprint))).size).toBe(findings.length);

    for (const f of findings) {
      // Age and repeat count are what make a finding meaningful. Resetting them re-reports the whole
      // estate as brand new, which is indistinguishable from a real incident.
      expect(f.status, 'a finding changed status during the upgrade').toBe('active');
      expect(f.first_seen_at, 'a finding lost its age').toBe(FIXED_DATES.firstSeen);
      expect(f.times_seen, 'a finding lost its repeat count').toBe(12);
    }
  });

  it('25-11 · pre-existing scan rows default to complete coverage (spec 004)', async () => {
    // These scans predate the coverage column entirely — every one of them ran through the old
    // all-or-nothing lifecycle, so 'complete' with no incomplete rules is the only correct default.
    // A NULL or empty string here would make every pre-upgrade scan row unreadable as a ScanSummary.
    const scans = rowsIfPresent(up.sqlite, 'scans');
    expect(scans.length).toBeGreaterThan(0);
    for (const scan of scans) {
      expect(scan.coverage, 'a pre-upgrade scan did not default to complete coverage').toBe('complete');
      expect(JSON.parse(String(scan.incomplete_rules ?? '[]'))).toEqual([]);
    }
  });

  it('25-05 · every rule a finding points at still exists', async () => {
    const ruleIds = new Set(readRules(up.sqlite).map(r => r.id));
    const dangling = rowsIfPresent(up.sqlite, 'findings')
      .map(f => String(f.rule_id))
      .filter(id => !ruleIds.has(id));
    expect([...new Set(dangling)], 'findings point at rules that no longer exist').toEqual([]);
  });

  it('25-06 · dashboards keep their widgets, layout and filters', async () => {
    const dashboards = rowsIfPresent(up.sqlite, 'dashboards');
    const mine = dashboards.find(d => d.id === up.built.dashboardId);
    expect(mine, 'the user dashboard is gone').toBeDefined();

    const config = JSON.parse(String(mine!.config)) as {
      widgets: { id: string; type: string; layout: Record<string, number> }[];
      filters: Record<string, unknown>;
    };
    expect(config.widgets.map(w => w.id)).toEqual(['w1', 'w2']);
    expect(config.widgets.map(w => w.type)).toEqual(['stat-card', 'top-policies']);
    expect(config.widgets[0]!.layout).toEqual({ x: 0, y: 0, w: 3, h: 2 });
    expect(config.widgets[1]!.layout).toEqual({ x: 3, y: 0, w: 6, h: 4 });
    expect(config.filters).toEqual({ category: 'cost', dateWindow: { mode: 'relative', days: 7 } });
  });

  it('25-09 · a suppression still refers to a finding that exists', async () => {
    if (!up.built.suppressionFingerprint) return;

    const suppressions = rowsIfPresent(up.sqlite, 'suppressions');
    expect(suppressions.length, 'the suppression was dropped').toBe(1);
    expect(suppressions[0]!.resource_id).toBe(SUPPRESSED_RESOURCE_ID);

    // The row surviving is not enough. A suppression is keyed on a fingerprint, so if the finding it
    // silences no longer carries that fingerprint, the suppression has silently stopped working and
    // an accepted risk starts being reported again.
    const findingFingerprints = new Set(
      rowsIfPresent(up.sqlite, 'findings').map(f => String(f.fingerprint)),
    );
    if (findingFingerprints.size === 0) return;
    expect(
      findingFingerprints.has(String(suppressions[0]!.fingerprint)),
      'the suppression no longer matches any finding — an accepted risk would start alerting again',
    ).toBe(true);
  });

  it('25-14 · every pre-029 ARG rule defaults to resource-graph / detect / state', async () => {
    // The two identity checks are the one deliberate exception — see the dedicated case below —
    // so they're excluded here rather than asserted against the ARG default.
    const IDENTITY_IDS = new Set(['cred:app-secret-expiring', 'cred:app-cert-expiring']);
    const rules = readRules(up.sqlite).filter(r => !IDENTITY_IDS.has(r.id));
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.queryBackend, `"${rule.name}" did not default to resource-graph`).toBe('resource-graph');
      expect(rule.shape, `"${rule.name}" did not default to detect`).toBe('detect');
      expect(rule.kind, `"${rule.name}" did not default to state`).toBe('state');
    }
  });

  it('25-15 · every pre-036 rule has a null logs_query, undisturbed by the new column (spec 036)', async () => {
    // Mirrors 25-14's shape: no fixture predates spec 036, so every rule in every upgraded shape
    // must land with an untouched, empty logs_query — proving the migration that adds the column
    // does not somehow backfill or corrupt it for rows that never had one.
    const IDENTITY_IDS = new Set(['cred:app-secret-expiring', 'cred:app-cert-expiring']);
    const rows = rowsIfPresent(up.sqlite, 'rules').filter(r => !IDENTITY_IDS.has(String(r.id)));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.logs_query, `"${String(row.name)}" should have no logs_query — it predates spec 036`).toBeNull();
    }
  });

  it('25-14 · the identity checks exist as ordinary microsoft-graph rules after the upgrade (spec 029)', async () => {
    const rules = readRules(up.sqlite);
    for (const id of ['cred:app-secret-expiring', 'cred:app-cert-expiring']) {
      const rule = rules.find(r => r.id === id);
      expect(rule, `"${id}" was not seeded as a rule row`).toBeDefined();
      expect(rule!.queryBackend, `"${id}" is not microsoft-graph`).toBe('microsoft-graph');
      expect(rule!.type, `"${id}" is not builtin`).toBe('builtin');
    }
  });
});

// ── A historical identity finding, seeded before its rule row existed (spec 029) ─

describe('TS-25 · a historical identity finding resolves once spec 029 seeds its rule (pre-rbac)', () => {
  // Every pre-029 install can have exactly this row: an identity finding whose rule_id has never
  // had a matching `rules` row, because identity checks were Graph-only and never rule-engine rows
  // before now. IDENTITY_RULE_IDS papered over the gap at read time; the migration closes it for real.
  const RULE_ID = 'cred:app-secret-expiring';
  const RESOURCE_ID = '/providers/Microsoft.aad/applications/aaaa1111-0000-0000-0000-000000000000/secrets/sync-secret';

  it('25-14 · the finding survives and now points at a real builtin rule', async () => {
    const sample = makeSample('pre-rbac');
    const fp = fingerprintFor(RULE_ID, RESOURCE_ID);

    const before = open(sample.file);
    try {
      before.prepare(`
        INSERT INTO findings (
          fingerprint, rule_id, category, severity, resource_id, resource_type, resource_name,
          subscription_id, resource_group, location, title, status, first_seen_at, last_seen_at, times_seen
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        fp, RULE_ID, 'identity', 'high', RESOURCE_ID, 'microsoft.aad/applications/secrets', 'Contoso Sync Service',
        '', null, null, 'A pre-upgrade identity finding', 'active', FIXED_DATES.firstSeen, FIXED_DATES.lastSeen, 3,
      );
    } finally { before.close(); }

    upgradeInProcess(sample);
    const sqlite = open(sample.file);
    try {
      const rules = readRules(sqlite);
      const rule = rules.find(r => r.id === RULE_ID);
      expect(rule, 'the app-secret-expiring rule was not seeded').toBeDefined();
      expect(rule!.queryBackend).toBe('microsoft-graph');

      const finding = rowsIfPresent(sqlite, 'findings').find(f => f.fingerprint === fp);
      expect(finding, 'the historical identity finding was dropped by the upgrade').toBeDefined();
      expect(finding!.status, 'an upgrade must not change a finding\'s status').toBe('active');

      // The generic invariant every other case in this file already checks, pinned here explicitly
      // because this is the exact scenario spec 029 exists to fix: no more dangling rule_id.
      const ruleIds = new Set(rules.map(r => r.id));
      expect(ruleIds.has(String(finding!.rule_id))).toBe(true);
    } finally { sqlite.close(); }
  });
});

// ── Schedules and users, which only some lineages have ────────────────────────

describe('TS-25 · schedules survive the move off the cron model', () => {
  let up: Upgraded;
  beforeAll(async () => { up = upgradeShape('cron-schedules'); });
  afterAll(() => up.sqlite.close());

  it('25-07 · both schedules are still present, with their names and targeting', async () => {
    const schedules = rowsIfPresent(up.sqlite, 'schedules');
    expect(schedules.map(s => s.name).sort()).toEqual(['Everything, weekly', 'Nightly cost sweep']);

    const nightly = schedules.find(s => s.name === 'Nightly cost sweep')!;
    expect(nightly.target_type).toBe('categories');
    expect(JSON.parse(String(nightly.target_values))).toEqual(['cost', 'security']);

    const weekly = schedules.find(s => s.name === 'Everything, weekly')!;
    expect(weekly.target_type).toBe('all');
  });

  it('25-07 · migrated schedules arrive switched off rather than guessed at', async () => {
    // Deliberate: the old cron model does not map onto the new recurrence model, so the upgrade
    // preserves the schedule but leaves it disabled for the user to confirm. A scan firing at a time
    // nobody chose is worse than one visibly paused. QA-TEST-PLAN 25-07 was corrected to match.
    const schedules = rowsIfPresent(up.sqlite, 'schedules');
    expect(schedules.every(s => s.enabled === 0)).toBe(true);
    expect(schedules.every(s => s.next_run_at === null)).toBe(true);
  });

  it('25-07 · run history from before the upgrade is kept', async () => {
    expect(await countRows(up.sqlite, 'schedule_runs')).toBe(1);
  });

  it('25-07 · a pre-existing run gains the overlap-safety columns as NULL, which recovery reads as stale (issue #88)', async () => {
    const [run] = rowsIfPresent(up.sqlite, 'schedule_runs');
    expect(run).toBeDefined();
    expect(run!.status).toBe('success');
    // Present, and unset: nothing about an old row is invented. A leftover 'running' row from an
    // older version has no heartbeat to be fresh, so recovery reaps it exactly as it did before.
    expect(run).toMatchObject({ heartbeat_at: null, owner_id: null, notify_claimed_at: null });
  });

  it('25-05 · snapshot history survives the table being rebuilt', async () => {
    const snapshots = rowsIfPresent(up.sqlite, 'posture_snapshots');
    expect(snapshots.length, 'trend history was lost in the table rebuild').toBe(1);
    expect(snapshots[0]!.category).toBe('cost');
    expect(snapshots[0]!.posture_pct).toBe(80);
    // The rebuild widens the key with a per-subscription column; existing aggregate rows take ''.
    expect(snapshots[0]!.subscription_id).toBe('');
  });
});

describe('TS-25 · users and access', () => {
  const savedAdmin = process.env.RULEBEAT_INITIAL_ADMIN;
  afterAll(async () => {
    if (savedAdmin === undefined) delete process.env.RULEBEAT_INITIAL_ADMIN;
    else process.env.RULEBEAT_INITIAL_ADMIN = savedAdmin;
  });

  // Superseded by B1b (2026-08-01): a zero-user install used to stay empty until someone signed
  // in via Entra, which only ever helped an install that already had Entra configured. It now
  // gets a bootstrapped local owner account instead — see the console-first-config plan — so
  // there is a way in even with no environment configured at all. Kept in place (not deleted) so
  // the reason for the assertion flip stays visible in the same file it was made in.
  it('25-08 · a pre-RBAC install with no bootstrap variable gets a local owner account, not a silent Entra grant', async () => {
    delete process.env.RULEBEAT_INITIAL_ADMIN;
    const up = upgradeShape('pre-rbac');
    try {
      expect(tableExists(up.sqlite, 'users')).toBe(true);
      const users = rowsIfPresent(up.sqlite, 'users');
      expect(users.length).toBe(1);
      expect(users[0]!.email).toBe('admin@rulebeat.local');
      expect(users[0]!.role).toBe('admin');
      expect(users[0]!.oid).toBe(null); // no Entra identity is linked — only a local password

      const accounts = rowsIfPresent(up.sqlite, 'local_accounts');
      expect(accounts.length).toBe(1);
      expect(accounts[0]!.user_id).toBe(users[0]!.id);
      expect(accounts[0]!.must_change_password).toBe(1);
    } finally { up.sqlite.close(); }
  });

  it('25-08 · upgrading twice never creates a second owner account', async () => {
    delete process.env.RULEBEAT_INITIAL_ADMIN;
    const sample = makeSample('pre-rbac');
    upgradeInProcess(sample);
    upgradeInProcess(sample);
    const sqlite = open(sample.file);
    try {
      expect(await countRows(sqlite, 'users')).toBe(1);
      expect(await countRows(sqlite, 'local_accounts')).toBe(1);
    } finally { sqlite.close(); }
  });

  it('25-08 · an install that already has users never gets an extra owner account or password file', async () => {
    // The project's standing rule: an upgrade must never disturb a user's existing configuration.
    // addUsers() seeds two real rows (ADMIN_USER, VIEWER_USER) before the upgrade runs, so this
    // exercises the actual "not zero users" branch rather than an empty fixture.
    delete process.env.RULEBEAT_INITIAL_ADMIN;
    const sample = makeSample('current');
    addUsers(sample.file);
    upgradeInProcess(sample);
    const sqlite = open(sample.file);
    try {
      expect(await countRows(sqlite, 'users')).toBe(2);
      expect(await countRows(sqlite, 'local_accounts')).toBe(0);
    } finally { sqlite.close(); }
  });

  // Spec 020: addUsers() builds a `users` table with no session_epoch column at all — the shape
  // every pre-spec-020 install is really in. If the idempotent ALTER didn't apply its DEFAULT to
  // existing rows (only to future inserts), every current session in the world would start
  // mismatching on the very next await getCurrentUser() call and everyone would be logged out at once.
  it('25-12 · existing user rows default to session epoch 0, not NULL, after the ALTER (spec 020)', async () => {
    delete process.env.RULEBEAT_INITIAL_ADMIN;
    const sample = makeSample('current');
    addUsers(sample.file);
    upgradeInProcess(sample);
    const sqlite = open(sample.file);
    try {
      const users = rowsIfPresent(sqlite, 'users');
      expect(users.length).toBeGreaterThan(0);
      for (const u of users) expect(u.session_epoch).toBe(0);
    } finally { sqlite.close(); }
  });

  it('25-08 · the bootstrap variable creates exactly one admin on a fresh install', async () => {
    process.env.RULEBEAT_INITIAL_ADMIN = 'boss@example.com';
    const up = upgradeShape('pre-rbac');
    try {
      const users = rowsIfPresent(up.sqlite, 'users');
      expect(users.length).toBe(1);
      expect(users[0]!.email).toBe('boss@example.com');
      expect(users[0]!.role).toBe('admin');
    } finally { up.sqlite.close(); }
  });
});
