/**
 * #271: the Postgres half of the finding placement upgrade. A database bootstrapped before placement
 * existed gains the columns, and the same plan the SQLite migration runs places every stored finding and
 * every Run History record on the next boot: a Graph finding in the directory with no subscription, a Logs
 * finding unplaceable until its workspace resolves, every other finding by its own columns. It changes no
 * fingerprint, age, status, event, row or suppression. Postgres only by nature; skipped on the default
 * SQLite run (db-migrations-finding-placement.test.ts makes the same assertions there).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { computeActivityFingerprint, computeFingerprint } from '@rulebeat/core/finding';
import { dbKind } from '@/lib/db/backend';
import { dbReady, pgDb } from '@/lib/db/client';
import { bootstrapPg } from '@/lib/db/pg/bootstrap';
import { resetDb } from '../helpers/db';

const SUB = '00000000-0000-0000-0000-000000000000';
const ARG_RULE = 'pg-plc-arg-rule';
const GRAPH_RULE = 'pg-plc-graph-rule';
const LOGS_RULE = 'pg-plc-logs-rule';
const SCAN = 'pg-plc-scan-1';

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

const raw = async (statement: string) => (await pgDb!.execute(sql.raw(statement))).rows as Record<string, unknown>[];
const lit = (v: string | null) => (v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`);

async function insertRule(id: string, backend: string): Promise<void> {
  await raw(`DELETE FROM rules WHERE id = '${id}'`);
  await raw(`
    INSERT INTO rules (id, name, description, category, severity, enabled, scope, resource_types, conditions, raw_kql, graph_query, logs_query, query_backend, type)
    VALUES ('${id}', '${id}', 'test', 'identity', 'medium', true, '{"level":"subscription"}', '[]', '[]',
      ${backend === 'resource-graph' ? `'resources | project id, name, type, location, resourceGroup, subscriptionId'` : 'NULL'},
      ${backend === 'microsoft-graph' ? `'{"path":"applications"}'` : 'NULL'},
      ${backend === 'log-analytics' ? `'{"kql":"SigninLogs","timeWindowDays":30}'` : 'NULL'}, '${backend}', 'custom')`);
}

interface Seed {
  fingerprint: string; ruleId: string; kind?: string; resourceId: string | null; dimensionKey?: string;
  subscriptionId: string; resourceGroup: string | null; status?: string;
}

async function insertFinding(f: Seed): Promise<void> {
  const name = f.resourceId ?? f.dimensionKey ?? 'n';
  await raw(`
    INSERT INTO findings (fingerprint, rule_id, category, severity, kind, dimension_key, resource_id, resource_type, resource_name,
      subscription_id, resource_group, title, evidence, evidence_rows, status, first_seen_at, last_seen_at, last_scan_id, times_seen, row_count, rows_scan_id)
    VALUES ('${f.fingerprint}', '${f.ruleId}', 'identity', 'medium', '${f.kind ?? 'state'}', ${lit(f.dimensionKey ?? null)}, ${lit(f.resourceId)}, 'x/y', ${lit(name)},
      '${f.subscriptionId}', ${lit(f.resourceGroup)}, 'A finding', '{"n":1}', '[{"n":1}]', '${f.status ?? 'active'}',
      '2026-01-02T03:04:05.000Z', '2026-02-03T04:05:06.000Z', '${SCAN}', 7, 1, '${SCAN}')`);
  await raw(`INSERT INTO finding_rows (fingerprint, position, data) VALUES ('${f.fingerprint}', 0, '{"n":1}')`);
  await raw(`INSERT INTO finding_events (id, fingerprint, rule_id, category, scan_id, type, occurred_at)
    VALUES ('event-${f.fingerprint}', '${f.fingerprint}', '${f.ruleId}', 'identity', '${SCAN}', 'created', '2026-01-02T03:04:05.000Z')`);
  await raw(`
    INSERT INTO scan_findings (scan_id, fingerprint, rule_id, severity, title, kind, category, resource_id, resource_name, resource_type, resource_group, subscription_id, row_count)
    VALUES ('${SCAN}', '${f.fingerprint}', '${f.ruleId}', 'medium', 'A finding', '${f.kind ?? 'state'}', 'identity', ${lit(f.resourceId)}, ${lit(name)}, 'x/y', ${lit(f.resourceGroup)}, '${f.subscriptionId}', 1)`);
}

/** The database as the previous release left it: no placement columns, a Graph finding and a Logs finding on the borrowed subscription. */
async function previousReleaseDatabase(): Promise<void> {
  await dbReady;
  await resetDb();
  await bootstrapPg(pgDb!);
  for (const table of ['findings', 'scan_findings']) {
    await raw(`ALTER TABLE ${table} DROP COLUMN placement, DROP COLUMN management_group_id`);
  }
  await insertRule(ARG_RULE, 'resource-graph');
  await insertRule(GRAPH_RULE, 'microsoft-graph');
  await insertRule(LOGS_RULE, 'log-analytics');
  await raw(`
    INSERT INTO scans (id, module, started_at, finished_at, duration_ms, subscriptions_scanned, findings, counts, total_rules, has_records)
    VALUES ('${SCAN}', 'identity', '2026-02-03T04:05:06.000Z', '2026-02-03T04:05:06.000Z', 10, '[]', '[]', '{}', 3, 1)`);
  await insertFinding({ fingerprint: fp.resource, ruleId: ARG_RULE, resourceId: vm('vm-1'), subscriptionId: SUB, resourceGroup: 'rg-app' });
  await insertFinding({ fingerprint: fp.subscription, ruleId: ARG_RULE, resourceId: SUBSCRIPTION_ID, subscriptionId: SUB, resourceGroup: null });
  await insertFinding({ fingerprint: fp.managementGroup, ruleId: ARG_RULE, resourceId: MG_ID, subscriptionId: '', resourceGroup: null });
  await insertFinding({ fingerprint: fp.unplaceable, ruleId: ARG_RULE, resourceId: TENANT_ID, subscriptionId: '', resourceGroup: null });
  await insertFinding({ fingerprint: fp.graph, ruleId: GRAPH_RULE, resourceId: APP_ID, subscriptionId: SUB, resourceGroup: null, status: 'fixed' });
  await insertFinding({ fingerprint: fp.logs, ruleId: LOGS_RULE, kind: 'activity', resourceId: null, dimensionKey: 'user-1', subscriptionId: SUB, resourceGroup: null });
  await raw(`INSERT INTO suppressions (id, fingerprint, resource_id, reason, suppressed_at)
    VALUES ('sup-graph', '${fp.graph}', '${APP_ID}', 'Accepted risk', '2026-02-01T00:00:00.000Z')`);
}

const placementOf = async (table: 'findings' | 'scan_findings') =>
  Object.fromEntries((await raw(`SELECT fingerprint, placement, management_group_id, subscription_id, resource_group FROM ${table}`)).map(r => [r.fingerprint, r]));

const KEPT = 'fingerprint, rule_id, kind, status, first_seen_at, last_seen_at, times_seen, resolved_at, last_scan_id, title, resource_id, evidence';
const whatMustNotMove = async () => ({
  findings: await raw(`SELECT ${KEPT} FROM findings ORDER BY fingerprint COLLATE "C"`),
  events: await raw(`SELECT * FROM finding_events ORDER BY id COLLATE "C"`),
  rows: await raw(`SELECT * FROM finding_rows ORDER BY fingerprint COLLATE "C", position`),
  suppressions: await raw(`SELECT * FROM suppressions ORDER BY id COLLATE "C"`),
});

describe.skipIf(dbKind !== 'pg')('bootstrapPg places every finding (#271)', () => {
  afterEach(async () => {
    await bootstrapPg(pgDb!);
    await resetDb();
  });

  it('places every stored finding and every Run History record by its rule and its own columns', async () => {
    await previousReleaseDatabase();

    await bootstrapPg(pgDb!);

    for (const table of ['findings', 'scan_findings'] as const) {
      const placed = await placementOf(table);
      expect(placed[fp.resource]).toMatchObject({ placement: 'resource', management_group_id: null, subscription_id: SUB, resource_group: 'rg-app' });
      expect(placed[fp.subscription]).toMatchObject({ placement: 'subscription', subscription_id: SUB, resource_group: null });
      expect(placed[fp.managementGroup]).toMatchObject({ placement: 'management-group', management_group_id: 'mg-platform', subscription_id: '' });
      expect(placed[fp.unplaceable]).toMatchObject({ placement: 'unplaceable', management_group_id: null, subscription_id: '' });
      expect(placed[fp.graph]).toMatchObject({ placement: 'directory', subscription_id: '', resource_group: null, management_group_id: null });
      expect(placed[fp.logs]).toMatchObject({ placement: 'unplaceable', subscription_id: '', resource_group: null });
    }
  });

  it('changes no fingerprint, age, status, event, row or suppression', async () => {
    await previousReleaseDatabase();
    const before = await whatMustNotMove();

    await bootstrapPg(pgDb!);

    expect(await whatMustNotMove()).toEqual(before);
  });

  it('leaves a second boot with nothing to change, and corrects what a returning previous release wrote', async () => {
    await previousReleaseDatabase();
    await bootstrapPg(pgDb!);
    const first = { findings: await placementOf('findings'), records: await placementOf('scan_findings') };

    await bootstrapPg(pgDb!);
    expect({ findings: await placementOf('findings'), records: await placementOf('scan_findings') }).toEqual(first);

    // The previous release writes the borrowed subscription over a Graph finding and takes the column default.
    await raw(`UPDATE findings SET placement = 'resource', subscription_id = '${SUB}' WHERE fingerprint = '${fp.graph}'`);
    await raw(`UPDATE scan_findings SET placement = 'resource', subscription_id = '${SUB}' WHERE fingerprint = '${fp.graph}'`);
    await bootstrapPg(pgDb!);
    for (const table of ['findings', 'scan_findings'] as const) {
      expect((await placementOf(table))[fp.graph]).toMatchObject({ placement: 'directory', subscription_id: '' });
    }
  });

  it('leaves a Logs finding already placed at its workspace as it is', async () => {
    await previousReleaseDatabase();
    await bootstrapPg(pgDb!);
    await raw(`UPDATE findings SET placement = 'workspace', subscription_id = 'sub-ws', resource_group = 'rg-logs' WHERE fingerprint = '${fp.logs}'`);

    await bootstrapPg(pgDb!);

    expect((await placementOf('findings'))[fp.logs]).toMatchObject({ placement: 'workspace', subscription_id: 'sub-ws', resource_group: 'rg-logs' });
  });
});
