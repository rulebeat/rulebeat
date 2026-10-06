/**
 * Ticket #163 (spec #152, ADR 0004): the startup seeder records every shipped definition as a rule
 * version and never changes what an enabled rule runs.
 *
 * Driven through `runMigrations` + `runSeeds` with an injected catalogue (the test seam), against a
 * throwaway SQLite file. The Postgres twin is covered in pg-rule-versions.test.ts, which runs the
 * same scenarios through `seedPg`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase, runMigrations, runSeeds } from '@/lib/db/migrate';
import { BEFORE_VERSIONING, BEFORE_VERSIONING_SORT_KEY, versionSortKey } from '@/lib/rule-versions';
import type { ShippedCatalogue } from '@/lib/shipped-catalogue';
import { catalogueOf, shippedRule } from '../helpers/catalogue';

const APRL_VERSION = '2026-06-08T13:06:47Z';
const CORE_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const GRAPH_ID = 'cred:app-secret-expiring';
const SHIPPED_GRAPH = { path: 'applications', expand: { arrayField: 'passwordCredentials', dateField: 'endDateTime', itemIdField: 'keyId', resourceType: 'microsoft.graph/application/secret', bands: [{ maxDays: 30, severity: 'high' }] } };
const TUNED_GRAPH = { path: 'applications', filter: "startswith(displayName,'internal-')" };

let dir: string;
let sqlite: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rb-rule-versions-'));
  sqlite = openDatabase(join(dir, 'rulebeat.db'));
  runMigrations(sqlite);
});

function seed(catalogue: ShippedCatalogue): void {
  runSeeds(sqlite, dir, { skipOwnerBootstrap: true, catalogue });
}

function row(id: string): Record<string, unknown> {
  return sqlite.prepare(`SELECT * FROM rules WHERE id = ?`).get(id) as Record<string, unknown>;
}
function versionsOf(id: string): string[] {
  return (sqlite.prepare(`SELECT version FROM rule_versions WHERE rule_id = ? ORDER BY version`).all(id) as { version: string }[]).map(v => v.version);
}
function definitionOf(id: string, version: string): Record<string, unknown> {
  const r = sqlite.prepare(`SELECT definition FROM rule_versions WHERE rule_id = ? AND version = ?`).get(id, version) as { definition: string };
  return JSON.parse(r.definition) as Record<string, unknown>;
}
/** Puts the database back in the state an install had before versions existed. */
function forgetVersions(): void {
  sqlite.exec(`UPDATE rules SET version = NULL, retired_at = NULL, origin_rule_id = NULL, origin_version = NULL; DELETE FROM rule_versions;`);
}

describe('a fresh install', () => {
  it('records the shipped version of every rule and runs it', () => {
    const core = shippedRule({ id: 'core-1', version: '1.0.0', releaseNote: 'Initial version.' });
    const aprl = shippedRule({ id: 'aprl-1', pack: 'aprl-v2', versionScheme: 'upstream-commit-date', version: APRL_VERSION, releaseNote: 'APRL sync.', upstreamRef: '1824eb5958d11482f6e23c231f0cb1d2d5bd44f6', enabled: false });
    seed(catalogueOf(core, aprl));

    expect(row('core-1').version).toBe('1.0.0');
    expect(versionsOf('core-1')).toEqual(['1.0.0']);
    expect(row('aprl-1').version).toBe(APRL_VERSION);
    expect(versionsOf('aprl-1')).toEqual([APRL_VERSION]);
    const stored = sqlite.prepare(`SELECT release_note, upstream_ref FROM rule_versions WHERE rule_id = 'aprl-1'`).get();
    expect(stored).toEqual({ release_note: 'APRL sync.', upstream_ref: '1824eb5958d11482f6e23c231f0cb1d2d5bd44f6' });
    expect(sqlite.prepare(`SELECT version, sort_key, first_seen_at FROM rule_versions WHERE rule_id IN ('core-1', 'aprl-1') ORDER BY rule_id`).all()).toEqual([
      { version: APRL_VERSION, sort_key: versionSortKey('upstream-commit-date', APRL_VERSION), first_seen_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) },
      { version: '1.0.0', sort_key: versionSortKey('semver', '1.0.0'), first_seen_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) },
    ]);
    expect(definitionOf('core-1', '1.0.0').name).toBe('Test rule');
  });

  it('enables a rule exactly as the catalogue says', () => {
    seed(catalogueOf(shippedRule({ id: 'on', enabled: true }), shippedRule({ id: 'off', enabled: false })));
    expect([row('on').enabled, row('off').enabled]).toEqual([1, 0]);
  });
});

describe('a changed shipped definition', () => {
  const v1 = () => shippedRule({ id: CORE_ID, version: '1.0.0', definition: { name: 'Old name', severity: 'low' } });
  const v2 = () => shippedRule({ id: CORE_ID, version: '1.1.0', releaseNote: 'Raised severity.', definition: { name: 'New name', severity: 'high' } });

  it('is recorded but not applied to an enabled rule, on every restart', () => {
    seed(catalogueOf(v1()));
    for (let restart = 0; restart < 3; restart++) seed(catalogueOf(v2()));

    expect(versionsOf(CORE_ID)).toEqual(['1.0.0', '1.1.0']);
    const r = row(CORE_ID);
    expect([r.name, r.severity, r.version]).toEqual(['Old name', 'low', '1.0.0']);
    expect(definitionOf(CORE_ID, '1.1.0')).toMatchObject({ name: 'New name', severity: 'high' });
  });

  it('is applied to a disabled rule, which stays disabled', () => {
    seed(catalogueOf(v1()));
    sqlite.prepare(`UPDATE rules SET enabled = 0 WHERE id = ?`).run(CORE_ID);
    seed(catalogueOf(v2()));

    const r = row(CORE_ID);
    expect([r.name, r.severity, r.version, r.enabled]).toEqual(['New name', 'high', '1.1.0', 0]);
  });

  it('never moves a disabled rule back to an older version', () => {
    seed(catalogueOf(v2()));
    sqlite.prepare(`UPDATE rules SET enabled = 0 WHERE id = ?`).run(CORE_ID);
    seed(catalogueOf(v1()));
    expect([row(CORE_ID).name, row(CORE_ID).version]).toEqual(['New name', '1.1.0']);
  });

  it('leaves the admin\'s own fields alone however the rule moves', () => {
    seed(catalogueOf(v1()));
    sqlite.prepare(`UPDATE rules SET enabled = 0, tags = '["mine"]', last_run_status = 'success', last_run_at = '2026-01-01T00:00:00Z' WHERE id = ?`).run(CORE_ID);
    seed(catalogueOf(v2()));
    const r = row(CORE_ID);
    expect([r.enabled, r.tags, r.last_run_status, r.last_run_at]).toEqual([0, '["mine"]', 'success', '2026-01-01T00:00:00Z']);
  });

  it('orders APRL commit timestamps, so two syncs on one day still move a disabled rule forward', () => {
    const early = shippedRule({ id: 'a', pack: 'aprl-v2', versionScheme: 'upstream-commit-date', version: '2026-06-08T09:00:00Z', enabled: false, definition: { name: 'morning' } });
    const late = shippedRule({ id: 'a', pack: 'aprl-v2', versionScheme: 'upstream-commit-date', version: '2026-06-08T13:06:47Z', enabled: false, definition: { name: 'afternoon' } });
    seed(catalogueOf(early));
    seed(catalogueOf(late));
    expect([row('a').name, row('a').version]).toEqual(['afternoon', '2026-06-08T13:06:47Z']);
  });
});

describe('a rule no pack ships any more', () => {
  it('is marked retired, keeps running and keeps its definition', () => {
    seed(catalogueOf(shippedRule({ id: 'gone' }), shippedRule({ id: 'stays', definition: { name: 'Other' } })));
    seed(catalogueOf(shippedRule({ id: 'stays', definition: { name: 'Other' } })));

    const gone = row('gone');
    expect(gone.retired_at).toEqual(expect.any(String));
    expect([gone.enabled, gone.type, gone.name, gone.version]).toEqual([1, 'builtin', 'Test rule', '1.0.0']);
    expect(row('stays').retired_at).toBeNull();
  });

  it('is not retired when the packs were not looked at or the pack file could not be read', () => {
    const aprl = shippedRule({ id: 'aprl-1', pack: 'aprl-v2', versionScheme: 'upstream-commit-date', version: APRL_VERSION });
    seed(catalogueOf(aprl));
    seed({ rules: [], packsDirRead: false, unreadablePacks: [] });
    seed({ rules: [], packsDirRead: true, unreadablePacks: ['aprl-v2'] });
    expect(row('aprl-1').retired_at).toBeNull();
  });

  it('is retired when the packs were read and the whole pack file is gone', () => {
    const aprl = shippedRule({ id: 'aprl-1', pack: 'aprl-v2', versionScheme: 'upstream-commit-date', version: APRL_VERSION });
    seed(catalogueOf(aprl));
    seed(catalogueOf(shippedRule({ id: 'core-1' })));
    expect(row('aprl-1').retired_at).toEqual(expect.any(String));
  });

  it('stops being retired when a later release ships it again', () => {
    seed(catalogueOf(shippedRule({ id: 'back' }), shippedRule({ id: 'other' })));
    seed(catalogueOf(shippedRule({ id: 'other' })));
    expect(row('back').retired_at).not.toBeNull();
    seed(catalogueOf(shippedRule({ id: 'back' }), shippedRule({ id: 'other' })));
    expect(row('back').retired_at).toBeNull();
  });

  it('is never read from a custom or community rule', () => {
    seed(catalogueOf(shippedRule({ id: 'core-1' })));
    for (const type of ['custom', 'community']) {
      sqlite.prepare(`INSERT INTO rules (id, name, description, category, severity, enabled, scope, resource_types, conditions, type) VALUES (?, ?, 'd', 'security', 'low', 1, '{"level":"resource"}', '[]', '[]', ?)`).run(`mine-${type}`, `Mine ${type}`, type);
    }
    seed(catalogueOf(shippedRule({ id: 'core-1' })));
    for (const type of ['custom', 'community']) {
      const r = row(`mine-${type}`);
      expect([r.retired_at, r.version, r.type, r.name]).toEqual([null, null, type, `Mine ${type}`]);
    }
    expect(versionsOf('mine-custom')).toEqual([]);
  });
});

describe('the first start after versions shipped', () => {
  it('records the version a row already runs when its stored definition is the shipped one', () => {
    seed(catalogueOf(shippedRule({ id: CORE_ID })));
    forgetVersions();
    seed(catalogueOf(shippedRule({ id: CORE_ID })));
    expect(row(CORE_ID).version).toBe('1.0.0');
    expect(versionsOf(CORE_ID)).toEqual(['1.0.0']);
  });

  it('keeps a differing stored definition running as "Before versioning" and still records the shipped one', () => {
    seed(catalogueOf(shippedRule({ id: CORE_ID })));
    forgetVersions();
    sqlite.prepare(`UPDATE rules SET severity = 'critical', description = 'tuned by an admin' WHERE id = ?`).run(CORE_ID);
    seed(catalogueOf(shippedRule({ id: CORE_ID })));

    const r = row(CORE_ID);
    expect([r.version, r.severity, r.description]).toEqual([BEFORE_VERSIONING, 'critical', 'tuned by an admin']);
    expect(versionsOf(CORE_ID)).toEqual(['1.0.0', BEFORE_VERSIONING]);
    expect(sqlite.prepare(`SELECT version FROM rule_versions WHERE rule_id = ? ORDER BY sort_key`).all(CORE_ID)).toEqual([{ version: BEFORE_VERSIONING }, { version: '1.0.0' }]);
    expect(sqlite.prepare(`SELECT sort_key FROM rule_versions WHERE rule_id = ? AND version = ?`).get(CORE_ID, BEFORE_VERSIONING)).toEqual({ sort_key: BEFORE_VERSIONING_SORT_KEY });
    expect(definitionOf(CORE_ID, BEFORE_VERSIONING)).toMatchObject({ severity: 'critical', description: 'tuned by an admin' });
    expect(definitionOf(CORE_ID, '1.0.0')).toMatchObject({ severity: 'medium' });
  });

  it('keeps an enabled "Before versioning" rule there when a newer version ships', () => {
    seed(catalogueOf(shippedRule({ id: CORE_ID })));
    forgetVersions();
    sqlite.prepare(`UPDATE rules SET severity = 'critical' WHERE id = ?`).run(CORE_ID);
    seed(catalogueOf(shippedRule({ id: CORE_ID })));
    seed(catalogueOf(shippedRule({ id: CORE_ID, version: '1.1.0', definition: { severity: 'low' } })));
    const r = row(CORE_ID);
    expect([r.version, r.severity, r.enabled]).toEqual([BEFORE_VERSIONING, 'critical', 1]);
    expect(versionsOf(CORE_ID)).toEqual(['1.0.0', '1.1.0', BEFORE_VERSIONING]);
  });

  it('moves a disabled rule whose stored definition differs to the shipped version, after recording the stored one', () => {
    seed(catalogueOf(shippedRule({ id: CORE_ID })));
    forgetVersions();
    sqlite.prepare(`UPDATE rules SET name = 'Renamed by hand', severity = 'critical', enabled = 0 WHERE id = ?`).run(CORE_ID);
    seed(catalogueOf(shippedRule({ id: CORE_ID })));

    const r = row(CORE_ID);
    expect([r.name, r.severity, r.version, r.enabled]).toEqual(['Test rule', 'medium', '1.0.0', 0]);
    expect(versionsOf(CORE_ID)).toEqual(['1.0.0', BEFORE_VERSIONING]);
    expect(definitionOf(CORE_ID, BEFORE_VERSIONING)).toMatchObject({ name: 'Renamed by hand', severity: 'critical' });
  });

  it('moves a rule left on "Before versioning" to the newest shipped version once it is disabled', () => {
    seed(catalogueOf(shippedRule({ id: CORE_ID })));
    forgetVersions();
    sqlite.prepare(`UPDATE rules SET severity = 'critical' WHERE id = ?`).run(CORE_ID);
    seed(catalogueOf(shippedRule({ id: CORE_ID })));
    expect(row(CORE_ID).version).toBe(BEFORE_VERSIONING);

    sqlite.prepare(`UPDATE rules SET enabled = 0 WHERE id = ?`).run(CORE_ID);
    seed(catalogueOf(shippedRule({ id: CORE_ID })));
    const r = row(CORE_ID);
    expect([r.version, r.severity, r.enabled]).toEqual(['1.0.0', 'medium', 0]);
    expect(definitionOf(CORE_ID, BEFORE_VERSIONING)).toMatchObject({ severity: 'critical' });
  });

  it('records a dropped rule\'s stored definition and retires it', () => {
    seed(catalogueOf(shippedRule({ id: 'gone' }), shippedRule({ id: 'stays', definition: { name: 'Other' } })));
    forgetVersions();
    seed(catalogueOf(shippedRule({ id: 'stays', definition: { name: 'Other' } })));
    const gone = row('gone');
    expect([gone.version, gone.enabled]).toEqual([BEFORE_VERSIONING, 1]);
    expect(gone.retired_at).not.toBeNull();
    expect(versionsOf('gone')).toEqual([BEFORE_VERSIONING]);
  });

  it('re-asserts type and pack on a row that has lost them, like the old seeder did', () => {
    seed(catalogueOf(shippedRule({ id: CORE_ID })));
    forgetVersions();
    sqlite.prepare(`UPDATE rules SET type = 'custom', pack = NULL WHERE id = ?`).run(CORE_ID);
    seed(catalogueOf(shippedRule({ id: CORE_ID })));
    expect([row(CORE_ID).type, row(CORE_ID).pack]).toEqual(['builtin', 'rulebeat-core']);
  });
});

describe('an Identity built-in', () => {
  const identity = () => shippedRule({
    id: GRAPH_ID,
    definition: { name: 'App secret expiring', category: 'identity', queryBackend: 'microsoft-graph', rawKql: null, graphQuery: SHIPPED_GRAPH as never, resourceTypes: [] },
  });

  it('with a tuned Graph query becomes a custom rule with the same id and query, and is not re-seeded', () => {
    seed(catalogueOf(identity()));
    forgetVersions();
    sqlite.prepare(`UPDATE rules SET graph_query = ? WHERE id = ?`).run(JSON.stringify(TUNED_GRAPH), GRAPH_ID);
    for (let restart = 0; restart < 2; restart++) seed(catalogueOf(identity()));

    const r = row(GRAPH_ID);
    expect([r.type, r.pack, r.version, r.origin_rule_id, r.origin_version, r.enabled]).toEqual(['custom', null, null, GRAPH_ID, '1.0.0', 1]);
    expect(JSON.parse(r.graph_query as string)).toEqual(TUNED_GRAPH);
    expect(versionsOf(GRAPH_ID)).toEqual([]);
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM rules WHERE id = ?`).get(GRAPH_ID)).toEqual({ n: 1 });
  });

  it('once converted stays custom even if its query is later edited to match the shipped one', () => {
    seed(catalogueOf(identity()));
    forgetVersions();
    sqlite.prepare(`UPDATE rules SET graph_query = ? WHERE id = ?`).run(JSON.stringify(TUNED_GRAPH), GRAPH_ID);
    seed(catalogueOf(identity()));
    sqlite.prepare(`UPDATE rules SET graph_query = ? WHERE id = ?`).run(JSON.stringify(SHIPPED_GRAPH), GRAPH_ID);
    seed(catalogueOf(identity()));
    const r = row(GRAPH_ID);
    expect([r.type, r.version, r.origin_rule_id]).toEqual(['custom', null, GRAPH_ID]);
    expect(versionsOf(GRAPH_ID)).toEqual([]);
  });

  it('with the shipped Graph query stays a built-in', () => {
    seed(catalogueOf(identity()));
    forgetVersions();
    seed(catalogueOf(identity()));
    const r = row(GRAPH_ID);
    expect([r.type, r.version, r.origin_rule_id]).toEqual(['builtin', '1.0.0', null]);
  });

  it('with no Graph query yet (a pre-032 row) gets the shipped query and stays a built-in', () => {
    seed(catalogueOf(identity()));
    forgetVersions();
    sqlite.prepare(`UPDATE rules SET graph_query = NULL, query_backend = 'resource-graph', kind = 'state' WHERE id = ?`).run(GRAPH_ID);
    seed(catalogueOf(identity()));
    const r = row(GRAPH_ID);
    expect([r.type, r.query_backend, r.version]).toEqual(['builtin', 'microsoft-graph', '1.0.0']);
    expect(JSON.parse(r.graph_query as string)).toEqual(SHIPPED_GRAPH);
  });
});

describe('a restart (migrations, then seeding)', () => {
  it('leaves a Graph rule with no raw KQL alone, whether built-in or custom', () => {
    const graph = shippedRule({
      id: GRAPH_ID,
      definition: { name: 'App secret expiring', category: 'identity', queryBackend: 'microsoft-graph', rawKql: null, graphQuery: SHIPPED_GRAPH as never, resourceTypes: [] },
    });
    seed(catalogueOf(graph));
    sqlite.prepare(
      `INSERT INTO rules (id, name, description, category, severity, enabled, scope, resource_types, conditions, type, query_backend, kind, graph_query)
       VALUES ('mine', 'Mine', '', 'identity', 'low', 1, '{}', '[]', '[]', 'custom', 'microsoft-graph', 'state', ?)`,
    ).run(JSON.stringify(TUNED_GRAPH));

    runMigrations(sqlite);
    seed(catalogueOf(graph));

    expect(sqlite.prepare(`SELECT id, raw_kql, conditions FROM rules ORDER BY id`).all()).toEqual([
      { id: GRAPH_ID, raw_kql: null, conditions: '[]' },
      { id: 'mine', raw_kql: null, conditions: '[]' },
    ]);
  });
});

describe('seeding twice', () => {
  it('changes nothing the second time', () => {
    const catalogue = catalogueOf(
      shippedRule({ id: 'a' }),
      shippedRule({ id: 'b', pack: 'aprl-v2', versionScheme: 'upstream-commit-date', version: APRL_VERSION, enabled: false, definition: { name: 'B' } }),
    );
    seed(catalogue);
    const snapshot = () => JSON.stringify([
      sqlite.prepare(`SELECT * FROM rules ORDER BY id`).all(),
      sqlite.prepare(`SELECT * FROM rule_versions ORDER BY rule_id, version`).all(),
    ]);
    const first = snapshot();
    seed(catalogue);
    expect(snapshot()).toBe(first);
  });

  it('skips a rule that cannot be written without losing the others', () => {
    const broken = shippedRule({ id: 'broken' });
    (broken.definition as { name: unknown }).name = null;
    seed(catalogueOf(broken, shippedRule({ id: 'fine', definition: { name: 'Fine' } })));
    expect(row('fine').version).toBe('1.0.0');
    expect(row('broken')).toBeUndefined();
  });
});
