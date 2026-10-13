/**
 * #271: the upgrade that gives every stored finding, and every Run History record, the place it sits.
 * Run on a database as the previous release left it: findings and records with no placement, a Graph
 * finding and a Logs finding each carrying the subscription they borrowed. Migrations swallow their own
 * errors, so these tests read the content back: what moved (placement, and the borrowed subscription),
 * and everything that must not (fingerprints, age, status, events, rows, suppressions).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { computeActivityFingerprint, computeFingerprint } from '@rulebeat/core/finding';
import { makeSample, open } from '../fixtures/upgrade';
import { runMigrations } from '@/lib/db/migrate';
import { placementRead } from '@/lib/db/finding-placement';

const SUB = '00000000-0000-0000-0000-000000000000';
const ARG_RULE = 'plc-arg-rule';
const GRAPH_RULE = 'plc-graph-rule';
const LOGS_RULE = 'plc-logs-rule';
const SCAN = 'plc-scan-1';

const vm = (name: string) => `/subscriptions/${SUB}/resourceGroups/rg-app/providers/microsoft.compute/virtualmachines/${name}`;
const SUBSCRIPTION_ID = `/subscriptions/${SUB}`;
const MG_ID = '/providers/Microsoft.Management/managementGroups/mg-platform';
const TENANT_ID = '/providers/Microsoft.Foo/things/t1';
const APP_ID = 'applications/app-1/passwordCredentials/key-1';

const fp = {
  resource: computeFingerprint(ARG_RULE, vm('vm-1')),
  subscription: computeFingerprint(ARG_RULE, SUBSCRIPTION_ID),
  managementGroup: computeFingerprint(ARG_RULE, MG_ID),
  unplaceable: computeFingerprint(ARG_RULE, TENANT_ID),
  graph: computeFingerprint(GRAPH_RULE, APP_ID),
  logs: computeActivityFingerprint(LOGS_RULE, 'user-1'),
};

let sqlite: Database.Database | undefined;
let closeProductDb: (() => void) | undefined;
afterEach(() => {
  sqlite?.close();
  sqlite = undefined;
  closeProductDb?.();
  closeProductDb = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function startProductOn(file: string) {
  vi.resetModules();
  vi.stubEnv('RULEBEAT_DATABASE_URL', '');
  vi.stubEnv('RULEBEAT_DATABASE_URL_FILE', '');
  vi.stubEnv('RULEBEAT_DB_PATH', file);
  const client = await import('@/lib/db/client');
  closeProductDb = () => client.rawSqlite?.close();
  const findings = await import('@/lib/db/findings');
  const suppressions = await import('@/lib/suppressions');
  return { listFindings: findings.listFindings, loadSuppressions: suppressions.loadSuppressions, isActiveSuppression: suppressions.isActiveSuppression };
}

const all = (db: Database.Database, text: string, ...params: unknown[]) => db.prepare(text).all(...params) as Record<string, unknown>[];

function insertRule(db: Database.Database, id: string, backend: string): void {
  db.prepare(`
    INSERT INTO rules (id, name, description, category, severity, enabled, scope, resource_types, conditions, raw_kql, graph_query, logs_query, query_backend, type)
    VALUES (?, ?, 'test', 'identity', 'medium', 1, '{"level":"subscription"}', '[]', '[]', ?, ?, ?, ?, 'custom')
  `).run(
    id, id,
    backend === 'resource-graph' ? 'resources | project id, name, type, location, resourceGroup, subscriptionId' : null,
    backend === 'microsoft-graph' ? '{"path":"applications"}' : null,
    backend === 'log-analytics' ? '{"kql":"SigninLogs","timeWindowDays":30}' : null,
    backend,
  );
}

interface Seed {
  fingerprint: string; ruleId: string; kind?: string; resourceId: string | null; dimensionKey?: string;
  subscriptionId: string; resourceGroup: string | null; status?: string;
}

function insertFinding(db: Database.Database, f: Seed): void {
  db.prepare(`
    INSERT INTO findings (fingerprint, rule_id, category, severity, kind, dimension_key, resource_id, resource_type, resource_name,
      subscription_id, resource_group, title, evidence, evidence_rows, status, first_seen_at, last_seen_at, last_scan_id, times_seen, row_count, rows_scan_id)
    VALUES (?, ?, 'identity', 'medium', ?, ?, ?, 'x/y', ?, ?, ?, 'A finding', '{"n":1}', '[{"n":1}]', ?,
      '2026-01-02T03:04:05.000Z', '2026-02-03T04:05:06.000Z', ?, 7, 1, ?)
  `).run(f.fingerprint, f.ruleId, f.kind ?? 'state', f.dimensionKey ?? null, f.resourceId, f.resourceId ?? f.dimensionKey ?? 'n',
    f.subscriptionId, f.resourceGroup, f.status ?? 'active', SCAN, SCAN);
  db.prepare(`INSERT INTO finding_rows (fingerprint, position, data) VALUES (?, 0, '{"n":1}')`).run(f.fingerprint);
  db.prepare(`INSERT INTO finding_events (id, fingerprint, rule_id, category, scan_id, type, occurred_at) VALUES (?, ?, ?, 'identity', ?, 'created', '2026-01-02T03:04:05.000Z')`)
    .run(`event-${f.fingerprint}`, f.fingerprint, f.ruleId, SCAN);
  db.prepare(`
    INSERT INTO scan_findings (scan_id, fingerprint, rule_id, severity, title, kind, category, resource_id, resource_name, resource_type, resource_group, subscription_id, row_count)
    VALUES (?, ?, ?, 'medium', 'A finding', ?, 'identity', ?, ?, 'x/y', ?, ?, 1)
  `).run(SCAN, f.fingerprint, f.ruleId, f.kind ?? 'state', f.resourceId, f.resourceId ?? f.dimensionKey ?? 'n', f.resourceGroup, f.subscriptionId);
}

/** The database as the previous release left it: no placement columns, a Graph finding and a Logs finding on the borrowed subscription. */
function previousReleaseDatabase() {
  const sample = makeSample('current');
  const db = open(sample.file);
  runMigrations(db);
  for (const table of ['findings', 'scan_findings']) {
    db.exec(`ALTER TABLE ${table} DROP COLUMN placement; ALTER TABLE ${table} DROP COLUMN management_group_id;`);
  }
  insertRule(db, ARG_RULE, 'resource-graph');
  insertRule(db, GRAPH_RULE, 'microsoft-graph');
  insertRule(db, LOGS_RULE, 'log-analytics');
  db.prepare(`
    INSERT INTO scans (id, module, started_at, finished_at, duration_ms, subscriptions_scanned, findings, counts, total_rules, has_records)
    VALUES (?, 'identity', '2026-02-03T04:05:06.000Z', '2026-02-03T04:05:06.000Z', 10, '[]', '[]', '{}', 3, 1)
  `).run(SCAN);
  insertFinding(db, { fingerprint: fp.resource, ruleId: ARG_RULE, resourceId: vm('vm-1'), subscriptionId: SUB, resourceGroup: 'rg-app' });
  insertFinding(db, { fingerprint: fp.subscription, ruleId: ARG_RULE, resourceId: SUBSCRIPTION_ID, subscriptionId: SUB, resourceGroup: null });
  insertFinding(db, { fingerprint: fp.managementGroup, ruleId: ARG_RULE, resourceId: MG_ID, subscriptionId: '', resourceGroup: null });
  insertFinding(db, { fingerprint: fp.unplaceable, ruleId: ARG_RULE, resourceId: TENANT_ID, subscriptionId: '', resourceGroup: null });
  insertFinding(db, { fingerprint: fp.graph, ruleId: GRAPH_RULE, resourceId: APP_ID, subscriptionId: SUB, resourceGroup: null, status: 'fixed' });
  insertFinding(db, { fingerprint: fp.logs, ruleId: LOGS_RULE, kind: 'activity', resourceId: null, dimensionKey: 'user-1', subscriptionId: SUB, resourceGroup: null });
  db.prepare(`INSERT INTO suppressions (id, fingerprint, resource_id, reason, suppressed_at) VALUES ('sup-graph', ?, ?, 'Accepted risk', '2026-02-01T00:00:00.000Z')`)
    .run(fp.graph, APP_ID);
  return { sample, db };
}

const placementOf = (db: Database.Database, table: 'findings' | 'scan_findings') =>
  Object.fromEntries(all(db, `SELECT fingerprint, placement, management_group_id, subscription_id, resource_group FROM ${table}`).map(r => [r.fingerprint, r]));

const KEPT = `fingerprint, rule_id, kind, status, first_seen_at, last_seen_at, times_seen, resolved_at, last_scan_id, title, resource_id, evidence`;

describe('upgrading to finding placement', () => {
  it('places every stored finding and every Run History record by its rule and its own columns', async () => {
    const { sample, db } = previousReleaseDatabase();
    db.close();

    await (await startProductOn(sample.file)).listFindings();
    sqlite = open(sample.file);

    for (const table of ['findings', 'scan_findings'] as const) {
      const placed = placementOf(sqlite, table);
      expect(placed[fp.resource]).toMatchObject({ placement: 'resource', management_group_id: null, subscription_id: SUB, resource_group: 'rg-app' });
      expect(placed[fp.subscription]).toMatchObject({ placement: 'subscription', subscription_id: SUB, resource_group: null });
      expect(placed[fp.managementGroup]).toMatchObject({ placement: 'management-group', management_group_id: 'mg-platform', subscription_id: '' });
      expect(placed[fp.unplaceable]).toMatchObject({ placement: 'unplaceable', management_group_id: null, subscription_id: '' });
      // The Graph finding sat under no subscription: the borrowed one is gone.
      expect(placed[fp.graph]).toMatchObject({ placement: 'directory', subscription_id: '', resource_group: null, management_group_id: null });
      // A Logs finding has no workspace until the startup step resolves one.
      expect(placed[fp.logs]).toMatchObject({ placement: 'unplaceable', subscription_id: '', resource_group: null });
    }
  });

  it('changes no fingerprint, age, status, event, row or suppression, and a suppression on a Graph finding still holds', async () => {
    const { sample, db } = previousReleaseDatabase();
    const before = {
      findings: all(db, `SELECT ${KEPT} FROM findings ORDER BY fingerprint`),
      events: all(db, `SELECT * FROM finding_events ORDER BY id`),
      rows: all(db, `SELECT * FROM finding_rows ORDER BY fingerprint, position`),
      suppressions: all(db, `SELECT * FROM suppressions ORDER BY id`),
    };
    db.close();

    const product = await startProductOn(sample.file);
    const live = await product.listFindings();
    sqlite = open(sample.file);

    expect(all(sqlite, `SELECT ${KEPT} FROM findings ORDER BY fingerprint`)).toEqual(before.findings);
    expect(all(sqlite, `SELECT * FROM finding_events ORDER BY id`)).toEqual(before.events);
    expect(all(sqlite, `SELECT * FROM finding_rows ORDER BY fingerprint, position`)).toEqual(before.rows);
    expect(all(sqlite, `SELECT * FROM suppressions ORDER BY id`)).toEqual(before.suppressions);

    // The suppression still names a finding that exists, so it still suppresses it.
    const graph = live.find(f => f.fingerprint === fp.graph);
    expect(graph).toMatchObject({ placement: 'directory', subscriptionId: '', firstSeenAt: '2026-01-02T03:04:05.000Z', timesSeen: 7, status: 'fixed' });
    const suppressed = (await product.loadSuppressions()).filter(product.isActiveSuppression).map(s => s.fingerprint);
    expect(suppressed).toEqual([fp.graph]);
  });

  it('leaves a second start with nothing to change', async () => {
    const { sample, db } = previousReleaseDatabase();
    db.close();
    await (await startProductOn(sample.file)).listFindings();
    closeProductDb?.();
    closeProductDb = undefined;

    sqlite = open(sample.file);
    const first = { findings: placementOf(sqlite, 'findings'), records: placementOf(sqlite, 'scan_findings') };
    runMigrations(sqlite);

    expect({ findings: placementOf(sqlite, 'findings'), records: placementOf(sqlite, 'scan_findings') }).toEqual(first);
  });

  it('reads, on a later start, only the rows that could still change', async () => {
    const { sample, db } = previousReleaseDatabase();
    db.close();
    await (await startProductOn(sample.file)).listFindings();
    closeProductDb?.();
    closeProductDb = undefined;

    sqlite = open(sample.file);
    // Resources, subscriptions and findings placed nowhere are right as they are, a Graph finding is
    // settled by one statement and a Logs finding by the startup step: only a management group's
    // finding, whose id the classification has to read, is looked at again.
    expect(all(sqlite, placementRead('findings')).map(r => r.fingerprint)).toEqual([fp.managementGroup]);
    expect(all(sqlite, placementRead('scan_findings')).map(r => r.fingerprint)).toEqual([fp.managementGroup]);
  });

  it('never moves a record out of the directory because its rule has been deleted', async () => {
    const { sample, db } = previousReleaseDatabase();
    db.close();
    await (await startProductOn(sample.file)).listFindings();
    closeProductDb?.();
    closeProductDb = undefined;

    // Deleting a rule removes its findings and keeps the Run History records its scans saved.
    sqlite = open(sample.file);
    expect(placementOf(sqlite, 'scan_findings')[fp.graph]).toMatchObject({ placement: 'directory' });
    sqlite.prepare(`DELETE FROM rules WHERE id = ?`).run(GRAPH_RULE);
    sqlite.prepare(`DELETE FROM findings WHERE rule_id = ?`).run(GRAPH_RULE);

    runMigrations(sqlite);

    expect(placementOf(sqlite, 'scan_findings')[fp.graph]).toMatchObject({ placement: 'directory', subscription_id: '', resource_group: null });
  });

  it('corrects the rows a returning previous release wrote on the next start', async () => {
    const { sample, db } = previousReleaseDatabase();
    db.close();
    await (await startProductOn(sample.file)).listFindings();
    closeProductDb?.();
    closeProductDb = undefined;

    // The previous release knows nothing of placement: a new Graph finding takes the column default and
    // the borrowed subscription, and a rescan of an old one writes the borrowed subscription over its own.
    sqlite = open(sample.file);
    const returned = computeFingerprint(GRAPH_RULE, 'applications/app-2/passwordCredentials/key-2');
    insertFinding(sqlite, { fingerprint: returned, ruleId: GRAPH_RULE, resourceId: 'applications/app-2/passwordCredentials/key-2', subscriptionId: SUB, resourceGroup: null });
    sqlite.prepare(`UPDATE findings SET placement = 'resource' WHERE fingerprint = ?`).run(returned);
    sqlite.prepare(`UPDATE findings SET subscription_id = ? WHERE fingerprint = ?`).run(SUB, fp.graph);
    sqlite.prepare(`UPDATE scan_findings SET placement = 'resource' WHERE fingerprint = ?`).run(returned);

    runMigrations(sqlite);

    for (const table of ['findings', 'scan_findings'] as const) {
      const placed = placementOf(sqlite, table);
      expect(placed[returned]).toMatchObject({ placement: 'directory', subscription_id: '' });
    }
    expect(placementOf(sqlite, 'findings')[fp.graph]).toMatchObject({ placement: 'directory', subscription_id: '' });
  });

  it('leaves a Logs finding already placed at its workspace as it is', async () => {
    const { sample, db } = previousReleaseDatabase();
    db.close();
    await (await startProductOn(sample.file)).listFindings();
    closeProductDb?.();
    closeProductDb = undefined;

    sqlite = open(sample.file);
    sqlite.prepare(`UPDATE findings SET placement = 'workspace', subscription_id = 'sub-ws', resource_group = 'rg-logs' WHERE fingerprint = ?`).run(fp.logs);
    runMigrations(sqlite);

    expect(placementOf(sqlite, 'findings')[fp.logs]).toMatchObject({ placement: 'workspace', subscription_id: 'sub-ws', resource_group: 'rg-logs' });
  });

  it('places a scan that is converted from its blob on the same start', async () => {
    const { sample, db } = previousReleaseDatabase();
    const blob = (over: Record<string, unknown>) => ({
      module: 'identity', severity: 'medium', category: 'identity', title: 'A finding', description: 'd', evidence: {}, recommendation: 'r',
      remediationSteps: [], detectedAt: '2026-01-02T03:04:05.000Z', ...over,
    });
    db.prepare(`
      INSERT INTO scans (id, module, started_at, finished_at, duration_ms, subscriptions_scanned, findings, counts, total_rules, has_records)
      VALUES ('plc-blob-scan', 'identity', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 10, '[]', ?, '{}', 3, 0)
    `).run(JSON.stringify([
      blob({ ruleId: ARG_RULE, resourceId: vm('vm-1'), subscriptionId: SUB, resourceGroup: 'rg-app' }),
      blob({ ruleId: GRAPH_RULE, resourceId: APP_ID, subscriptionId: SUB }),
      blob({ ruleId: LOGS_RULE, kind: 'activity', dimensionKey: 'user-1', subscriptionId: SUB }),
    ]));
    db.close();

    await (await startProductOn(sample.file)).listFindings();
    sqlite = open(sample.file);

    const records = all(sqlite, `SELECT rule_id, placement, subscription_id, resource_group FROM scan_findings WHERE scan_id = 'plc-blob-scan' ORDER BY rule_id`);
    expect(records).toEqual([
      { rule_id: ARG_RULE, placement: 'resource', subscription_id: SUB, resource_group: 'rg-app' },
      { rule_id: GRAPH_RULE, placement: 'directory', subscription_id: '', resource_group: null },
      { rule_id: LOGS_RULE, placement: 'unplaceable', subscription_id: '', resource_group: null },
    ]);
  });
});
