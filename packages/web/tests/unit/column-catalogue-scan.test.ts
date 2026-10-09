/**
 * ADR 0007: a rule's column catalogue is the set of columns its findings' stored rows hold, Fixed
 * findings included, rebuilt in the same transaction as every scan save so a view can list its
 * returned columns without reading a single row. Driven through runCategoryScan() over the fake
 * Azure context; the table is read through listReturnedColumns(), the one read the app makes.
 *
 * A scan save costs what it did before the catalogue: the rebuild starts from the rows this scan
 * wrote, and reads a stored row only to find a column that rows it did not write might hold.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { many, inTransaction, run as execRun } from '@/lib/db/exec';
import { columnCatalogue as columnCatalogueTable, rules as rulesTable } from '@/lib/db/tables';
import { getCategory } from '@/lib/db/categories';
import { deleteFindingsForRule, listFindings } from '@/lib/db/findings';
import { COLUMN_CATALOGUE_MARKER } from '@/lib/db/column-catalogue-build';
import { listReturnedColumns, rebuildColumnCatalogue } from '@/lib/db/column-catalogue';
import { deleteMeta, getMeta, setMeta } from '@/lib/db/meta';
import { rowLeafPaths } from '@/lib/finding-view';
import { runCategoryScan } from '@/lib/scan-runner';
import { resetDb } from '../helpers/db';
import { fakeTenantContext, argRow } from '../helpers/fake-azure';

const rowReads: { params: unknown[] }[] = [];

vi.mock('@/lib/db/exec', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/db/exec')>();
  const many = ((query: { toSQL(): { sql: string; params: unknown[] } }) => {
    const { sql, params } = query.toSQL();
    if (/from "finding_rows"/i.test(sql)) rowReads.push({ params });
    return original.many(query as never);
  }) as unknown as typeof original.many;
  return { ...original, many };
});

const RULE_A = 'test-catalogue-rule-a';
const RULE_B = 'test-catalogue-rule-b';
const KQL_A = 'resources | where type == "microsoft.compute/virtualmachines"';
const KQL_B = 'resources | where type == "microsoft.storage/storageaccounts"';

async function insertRule(id: string, kql: string): Promise<void> {
  await execRun(db.delete(rulesTable).where(eq(rulesTable.id, id)));
  await execRun(db.insert(rulesTable).values({
    id, name: id, description: 'test rule', category: 'identity', severity: 'medium', enabled: true,
    scope: JSON.stringify({ level: 'subscription' }), resourceTypes: '[]', conditions: '[]', type: 'custom', rawKql: kql,
  }));
}

/** One scan of the given rules, each answered from `held`, keyed by the rule's own query text. */
async function scan(ruleIds: string[], held: Record<string, Record<string, unknown>[]>, hoursFromBase = 0) {
  return runCategoryScan((await getCategory('identity'))!, {
    ctx: fakeTenantContext({ rows: kql => held[kql] ?? [] }),
    ruleIds,
    now: new Date(Date.UTC(2026, 5, 1, hoursFromBase)),
  });
}

const catalogueRows = () => many(db.select().from(columnCatalogueTable).where(eq(columnCatalogueTable.ruleId, RULE_A)));

beforeEach(async () => {
  await resetDb();
  await execRun(db.delete(columnCatalogueTable));
  await insertRule(RULE_A, KQL_A);
  await insertRule(RULE_B, KQL_B);
});

describe('a scan builds the column catalogue', () => {
  it('records the columns a rule\'s rows returned, walking nested objects', async () => {
    await scan([RULE_A], {
      [KQL_A]: [
        { ...argRow({ name: 'vm-one' }), properties: { sku: { name: 'S1' } }, zone: '1' },
        { ...argRow({ name: 'vm-one' }), extra: 'x' },
      ],
    });

    // The finding's own fields (id, name, type...) are not row columns; only what else the query returned is.
    expect(await listReturnedColumns([RULE_A])).toEqual(['extra', 'properties.sku.name', 'zone']);
    expect((await catalogueRows()).length).toBe(3);
  });

  it('keeps a column only a now-Fixed finding returned, after a rescan where that resource is gone', async () => {
    await scan([RULE_A], {
      [KQL_A]: [{ ...argRow({ name: 'vm-one' }), onlyOne: 'x' }, { ...argRow({ name: 'vm-two' }), shared: 'y' }],
    });
    await scan([RULE_A], { [KQL_A]: [{ ...argRow({ name: 'vm-two' }), shared: 'z' }] }, 24);
    // The third scan rebuilds the rule's entries while vm-one is already Fixed.
    await scan([RULE_A], { [KQL_A]: [{ ...argRow({ name: 'vm-two' }), shared: 'w' }] }, 48);
    expect((await listFindings()).find(f => f.resourceName === 'vm-one')!.status).toBe('fixed');

    expect(await listReturnedColumns([RULE_A])).toEqual(['onlyOne', 'shared']);
  });

  it('drops a column no stored row holds any more, once every finding that had it returns without it', async () => {
    await scan([RULE_A], { [KQL_A]: [{ ...argRow({ name: 'vm-one' }), old: 'x' }] });
    await scan([RULE_A], { [KQL_A]: [{ ...argRow({ name: 'vm-one' }), fresh: 'x' }] }, 24);

    expect(await listReturnedColumns([RULE_A])).toEqual(['fresh']);
  });

  it('lists only the asked rules\' columns, and every rule\'s when none are asked for', async () => {
    await scan([RULE_A, RULE_B], {
      [KQL_A]: [{ ...argRow({ name: 'vm-one' }), a: 1 }],
      [KQL_B]: [{ ...argRow({ name: 'st-one', type: 'microsoft.storage/storageaccounts' }), b: 1 }],
    });

    expect(await listReturnedColumns([RULE_A])).toEqual(['a']);
    expect(await listReturnedColumns([RULE_B])).toEqual(['b']);
    expect(await listReturnedColumns([RULE_A, RULE_B])).toEqual(['a', 'b']);
    expect(await listReturnedColumns()).toEqual(['a', 'b']);
    expect(await listReturnedColumns([])).toEqual([]);
    expect(await listReturnedColumns(['no-such-rule'])).toEqual([]);
  });

  it('keeps the paths when the rule was capped, rebuilding them from the rows still stored', async () => {
    await scan([RULE_A], { [KQL_A]: [{ ...argRow({ name: 'vm-one' }), kept: 1 }] });
    await insertRule(RULE_A, `${KQL_A} | take 1`);
    const capped = await scan([RULE_A], { [`${KQL_A} | take 1`]: [{ ...argRow({ name: 'vm-one' }), fromCapped: 1 }] }, 24);
    expect(capped.summary.incompleteRules.map(r => r.status)).toEqual(['capped']);

    expect(await listReturnedColumns([RULE_A])).toEqual(['kept']);
  });
});

describe('the rebuild reads stored rows only when it has to', () => {
  const written = (ruleId: string, fingerprint: string, ...rows: Record<string, unknown>[]) => ({ ruleId, fingerprint, data: rows.map(r => JSON.stringify(r)) });
  const rebuild = (...findings: ReturnType<typeof written>[]) => inTransaction(tx => rebuildColumnCatalogue(tx, findings));
  const fingerprintOf = async (name: string) => (await listFindings()).find(f => f.resourceName === name)!.fingerprint;

  beforeEach(() => { rowReads.length = 0; });

  it('reads no stored row when the rows written hold every column the rule had', async () => {
    await scan([RULE_A], { [KQL_A]: [{ ...argRow({ name: 'vm-one' }), a: 1 }, { ...argRow({ name: 'vm-two' }), b: 1 }] });
    const one = await fingerprintOf('vm-one');
    rowReads.length = 0;

    await rebuild(written(RULE_A, one, { a: 1, b: 2, c: 3 }));

    expect(rowReads).toEqual([]);
    expect(await listReturnedColumns([RULE_A])).toEqual(['a', 'b', 'c']);
  });

  it('reads only the rows of the findings it did not write, to find a column the rows written dropped', async () => {
    await scan([RULE_A], { [KQL_A]: [{ ...argRow({ name: 'vm-one' }), a: 1 }, { ...argRow({ name: 'vm-two' }), b: 1 }] });
    const [one, two] = [await fingerprintOf('vm-one'), await fingerprintOf('vm-two')];
    rowReads.length = 0;

    await rebuild(written(RULE_A, one, { c: 1 }));

    // `a` was only in the rows just replaced, so it goes; `b` is only in a row that was not.
    expect(await listReturnedColumns([RULE_A])).toEqual(['b', 'c']);
    expect(rowReads.length).toBe(1);
    expect(rowReads[0]!.params).toContain(two);
    expect(rowReads[0]!.params).not.toContain(one);
  });

  it('reads the stored rows of the others whenever the catalogue has not been proven built', async () => {
    await scan([RULE_A], { [KQL_A]: [{ ...argRow({ name: 'vm-one' }), a: 1 }, { ...argRow({ name: 'vm-two' }), b: 1 }] });
    const one = await fingerprintOf('vm-one');
    const marker = await getMeta(COLUMN_CATALOGUE_MARKER);
    expect(marker).not.toBeNull();
    await deleteMeta(COLUMN_CATALOGUE_MARKER);
    try {
      rowReads.length = 0;

      await rebuild(written(RULE_A, one, { a: 1, b: 1 }));

      expect(rowReads.length).toBeGreaterThan(0);
      expect(await listReturnedColumns([RULE_A])).toEqual(['a', 'b']);
    } finally {
      await setMeta(COLUMN_CATALOGUE_MARKER, marker!);
    }
  });

  it('leaves a rule alone when none of its rows were written', async () => {
    await scan([RULE_A], { [KQL_A]: [{ ...argRow({ name: 'vm-one' }), a: 1 }] });
    rowReads.length = 0;

    await rebuild();

    expect(rowReads).toEqual([]);
    expect(await listReturnedColumns([RULE_A])).toEqual(['a']);
  });

  it('holds exactly the columns of every stored row after each of a run of scans', async () => {
    const holdsStoredRows = async () => {
      const stored = (await listFindings()).filter(f => f.ruleId === RULE_A);
      expect(await listReturnedColumns([RULE_A])).toEqual(rowLeafPaths(stored));
    };
    const rowOf = (name: string, extra: Record<string, unknown>) => ({ ...argRow({ name }), ...extra });

    await scan([RULE_A], { [KQL_A]: [rowOf('vm-one', { a: 1, x: 1 }), rowOf('vm-two', { b: 1 })] });
    await holdsStoredRows();
    // vm-two is gone (Fixed, its rows stay), and vm-one lost a column.
    await scan([RULE_A], { [KQL_A]: [rowOf('vm-one', { a: 1 })] }, 24);
    await holdsStoredRows();
    // A new finding, and vm-one changes a column: only the Fixed finding still holds `b`.
    await scan([RULE_A], { [KQL_A]: [rowOf('vm-one', { a: 1, y: { deep: 1 } }), rowOf('vm-three', { z: 1 })] }, 48);
    await holdsStoredRows();
    // Everything rewritten with a superset.
    await scan([RULE_A], { [KQL_A]: [rowOf('vm-one', { a: 1, b: 1, y: { deep: 1 } }), rowOf('vm-three', { z: 1, w: 1 })] }, 72);
    await holdsStoredRows();
    // A capped rule keeps its rows, so its columns do not move.
    await insertRule(RULE_A, `${KQL_A} | take 1`);
    await scan([RULE_A], { [`${KQL_A} | take 1`]: [rowOf('vm-one', { fromCapped: 1 })] }, 96);
    await holdsStoredRows();
  });
});

describe('removing a rule\'s findings', () => {
  it('removes that rule\'s entries and no other rule\'s', async () => {
    await scan([RULE_A, RULE_B], {
      [KQL_A]: [{ ...argRow({ name: 'vm-one' }), a: 1 }],
      [KQL_B]: [{ ...argRow({ name: 'st-one', type: 'microsoft.storage/storageaccounts' }), b: 1 }],
    });

    await deleteFindingsForRule(RULE_A);

    expect(await listReturnedColumns([RULE_A])).toEqual([]);
    expect(await listReturnedColumns([RULE_B])).toEqual(['b']);
  });
});
