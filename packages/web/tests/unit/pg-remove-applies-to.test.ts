/**
 * Applies to was removed. A Postgres database bootstrapped while it existed carries three extra
 * columns on `rules`; `bootstrapPg` drops them on the next start and leaves the rule that used them,
 * its finding and its suppression exactly as they were. Postgres-only: the SQLite side of the same
 * contract lives in db-migrations-integrity.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { computeFingerprint } from '@rulebeat/core';
import { dbReady, pgDb } from '@/lib/db/client';
import { bootstrapPg } from '@/lib/db/pg/bootstrap';

const REMOVED_COLUMNS = ['applies_to', 'last_population_count', 'shape'];
const RULE_ID = '3f0c2a6e-9b1d-4c47-8e55-2d7a9f0b6c11';
const RESOURCE_ID = '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-app/providers/Microsoft.Storage/storageAccounts/stapp';

async function rows(q: string): Promise<Record<string, unknown>[]> {
  return (await pgDb!.execute(sql.raw(q))).rows as Record<string, unknown>[];
}

async function ruleColumns(): Promise<string[]> {
  return (await rows(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rules'`,
  )).map(r => String(r.column_name));
}

/** The rule without the removed columns, plus everything keyed on it. */
async function ruleAndDependents() {
  const [rule] = await rows(`SELECT * FROM rules WHERE id = '${RULE_ID}'`);
  return {
    rule: rule && Object.fromEntries(Object.entries(rule).filter(([k]) => !REMOVED_COLUMNS.includes(k))),
    findings: await rows(`SELECT * FROM findings WHERE rule_id = '${RULE_ID}'`),
    suppressions: await rows(`SELECT * FROM suppressions WHERE id = 's1'`),
  };
}

describe.runIf(process.env.RULEBEAT_TEST_PG_URL)('postgres bootstrap drops the Applies to columns', () => {
  it('drops all three, keeps the rule, its finding and its suppression, and stays dropped on restart', async () => {
    await dbReady;
    const fingerprint = computeFingerprint(RULE_ID, RESOURCE_ID);

    // Put the table back the way the last release with Applies to left it.
    await pgDb!.execute(sql.raw(`
      ALTER TABLE rules ADD COLUMN IF NOT EXISTS shape TEXT NOT NULL DEFAULT 'detect';
      ALTER TABLE rules ADD COLUMN IF NOT EXISTS applies_to TEXT;
      ALTER TABLE rules ADD COLUMN IF NOT EXISTS last_population_count INTEGER;
    `));
    await pgDb!.execute(sql`
      INSERT INTO rules (id, name, description, category, severity, enabled, scope, resource_types,
        conditions, raw_kql, visual_query, tags, type, query_backend, kind, last_run_status, last_run_at,
        shape, applies_to, last_population_count)
      VALUES (${RULE_ID}, 'Storage accounts below TLS 1.2', 'Checks the minimum TLS version', 'security', 'high', FALSE,
        ${JSON.stringify({ level: 'subscription' })}, ${JSON.stringify(['microsoft.storage/storageaccounts'])}, '[]',
        ${`resources | where type == 'microsoft.storage/storageaccounts' | where properties.minimumTlsVersion != 'TLS1_2'`},
        ${JSON.stringify({ stages: [] })}, ${JSON.stringify(['Production'])}, 'custom', 'resource-graph', 'state',
        'success', '2026-09-01T08:00:00.000Z',
        'assert', ${JSON.stringify({ stages: [] })}, 40)
    `);
    await pgDb!.execute(sql`
      INSERT INTO findings (fingerprint, rule_id, category, severity, resource_id, resource_type, resource_name,
        subscription_id, resource_group, title, first_seen_at, last_seen_at, times_seen)
      VALUES (${fingerprint}, ${RULE_ID}, 'security', 'high', ${RESOURCE_ID}, 'microsoft.storage/storageaccounts', 'stapp',
        '00000000-0000-0000-0000-000000000000', 'rg-app', 'Storage accounts below TLS 1.2',
        '2026-08-01T08:00:00.000Z', '2026-09-01T08:00:00.000Z', 7)
    `);
    await pgDb!.execute(sql`
      INSERT INTO suppressions (id, fingerprint, resource_id, reason, suppressed_at, expires_at)
      VALUES ('s1', ${fingerprint}, ${RESOURCE_ID}, 'Legacy client needs TLS 1.0 until the migration', '2026-08-15T08:00:00.000Z', NULL)
    `);
    expect(await ruleColumns()).toEqual(expect.arrayContaining(REMOVED_COLUMNS));
    const before = await ruleAndDependents();
    expect(before.rule, 'fixture rule missing').toBeDefined();
    expect(before.findings).toHaveLength(1);
    expect(before.suppressions).toHaveLength(1);
    // The one expected difference is the finding-rows copy recording that this finding has no rows.
    const expected = { ...before, findings: before.findings.map(f => ({ ...(f as object), row_count: 0 })) };

    await bootstrapPg(pgDb!);
    for (const column of REMOVED_COLUMNS) expect(await ruleColumns(), `${column} survived the bootstrap`).not.toContain(column);
    expect(await ruleAndDependents()).toEqual(expected);

    await bootstrapPg(pgDb!);
    for (const column of REMOVED_COLUMNS) expect(await ruleColumns(), `${column} came back on a later start`).not.toContain(column);
    expect(await ruleAndDependents()).toEqual(expected);
  });
});
