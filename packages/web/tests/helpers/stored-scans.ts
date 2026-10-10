/**
 * Scans stored the way a real scan save stores them: custom rules inserted, then `runCategoryScan()` run
 * over the fake Azure context. For tests that read what a scan save wrote (the snapshot route and its
 * export), so they never hand-write a record.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { run as execRun } from '@/lib/db/exec';
import { rules as rulesTable } from '@/lib/db/tables';
import { getCategory } from '@/lib/db/categories';
import { runCategoryScan } from '@/lib/scan-runner';
import { fakeTenantContext, argRow } from './fake-azure';

const ARG_KQL = 'resources | where type == "microsoft.compute/virtualmachines"';

const baseRule = {
  description: 'test rule',
  category: 'identity',
  enabled: true,
  scope: JSON.stringify({ level: 'subscription' }),
  resourceTypes: JSON.stringify([]),
  conditions: JSON.stringify([]),
  type: 'custom',
};

/** A rule and what it finds: the Resource Graph rows named in `vms`, or the Log Analytics dimension
 *  values in `users`. */
export interface Seed { id: string; name: string; severity: string; vms?: string[]; users?: string[] }

export async function seedRules(seeds: Seed[]): Promise<void> {
  for (const s of seeds) {
    await execRun(db.delete(rulesTable).where(eq(rulesTable.id, s.id)));
    const query = s.users
      ? {
        rawKql: null,
        queryBackend: 'log-analytics',
        logsQuery: JSON.stringify({ kql: `SigninLogs | where Marker == "${s.id}"`, timeWindowDays: 30, dimensionKeyField: 'UserId' }),
      }
      : { rawKql: `${ARG_KQL} | where tags.rule == "${s.id}"` };
    await execRun(db.insert(rulesTable).values({ ...baseRule, id: s.id, name: s.name, severity: s.severity, ...query }));
  }
}

/** Runs and stores one scan of the seeded rules, returning its summary with the id it was saved under. */
export async function scan(seeds: Seed[], hoursFromBase = 0) {
  await seedRules(seeds);
  const category = (await getCategory('identity'))!;
  const seedFor = (kql: string) => seeds.find(s => kql.includes(`"${s.id}"`));
  const outcome = await runCategoryScan(category, {
    ctx: fakeTenantContext({
      // A returned column beside the resource's own, so each finding holds one row.
      rows: kql => (seedFor(kql)?.vms ?? []).map(name => argRow({ name, zone: 'a' })),
      logsRows: kql => (seedFor(kql)?.users ?? []).map(UserId => ({ UserId })),
    }),
    ruleIds: seeds.map(s => s.id),
    now: new Date(Date.UTC(2026, 5, 1, hoursFromBase)),
  });
  const id = outcome.summary.id;
  if (!id) throw new Error('the scan was saved without an id');
  return { ...outcome.summary, id };
}
