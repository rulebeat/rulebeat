import { and, isNotNull, ne } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { many } from '@/lib/db/exec';
import { findings, scanFindings } from '@/lib/db/tables';
import { accessFilterSql } from '@/lib/db/access-filter';
import type { Access } from '@/lib/access-model';
import { indexPairs, type PairRow } from '@/lib/db/filter-conversion';

/**
 * Every subscription and resource group pair on record, as the upgrade reads it (`PAIRS_READ`): any finding or
 * Run History record, at any status, indexed by lower-cased resource group name. A save route that turns a
 * name-only resource group into Scope picks reads it, so a save and the upgrade give one answer, except
 * that a save sees only the pairs of the findings `access` can see; the upgrade runs install-wide.
 */
export async function readRecordedPairs(access: Access): Promise<ReturnType<typeof indexPairs>> {
  const rows: PairRow[] = [];
  for (const table of [findings, scanFindings]) {
    const found = await many(db.selectDistinct({ subscription_id: table.subscriptionId, resource_group: table.resourceGroup })
      .from(table)
      .where(and(ne(table.subscriptionId, ''), isNotNull(table.resourceGroup), ne(table.resourceGroup, ''), accessFilterSql(access, table))));
    for (const r of found) rows.push({ subscription_id: r.subscription_id, resource_group: r.resource_group! });
  }
  return indexPairs(rows);
}
