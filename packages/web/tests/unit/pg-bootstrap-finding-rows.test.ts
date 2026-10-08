/**
 * Issue #192: a Postgres database bootstrapped before `findings.evidence_rows` existed gains the
 * column on the next boot, keeps every finding and suppression it already held, and reads a
 * pre-rows finding back as one row made from its evidence. Asserted through the repositories the
 * app reads with, not raw SQL. Postgres only by nature; skipped on the default SQLite run.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { dbKind } from '@/lib/db/backend';
import { dbReady, pgDb } from '@/lib/db/client';
import { bootstrapPg } from '@/lib/db/pg/bootstrap';
import { listFindings } from '@/lib/db/findings';
import { addSuppression, loadSuppressions } from '@/lib/suppressions';
import { resetDb } from '../helpers/db';

const FINGERPRINT = 'pg-rows-fp';
const EVIDENCE = { retirement: 'Basic tier' };

describe.skipIf(dbKind !== 'pg')('bootstrapPg adds findings.evidence_rows to an existing database (issue #192)', () => {
  afterEach(async () => { await resetDb(); });

  it('keeps a pre-rows finding with its evidence, age and suppression, and reads it back as one row', async () => {
    await dbReady;
    await resetDb();
    await bootstrapPg(pgDb!);
    await pgDb!.execute(sql.raw('ALTER TABLE findings DROP COLUMN evidence_rows'));
    await pgDb!.execute(sql.raw(`
      INSERT INTO findings (fingerprint, rule_id, category, severity, subscription_id, title, evidence, status,
        first_seen_at, last_seen_at, times_seen)
      VALUES ('${FINGERPRINT}', 'pg-rows-rule', 'reliability', 'medium', 'sub', 'VM retirements', '${JSON.stringify(EVIDENCE)}',
        'active', '2026-01-02T03:04:05.000Z', '2026-02-03T04:05:06.000Z', 9)
    `));
    await addSuppression({ id: 'pg-rows-sup', fingerprint: FINGERPRINT, reason: 'Accepted risk', suppressedAt: '2026-02-01T00:00:00.000Z' });

    await bootstrapPg(pgDb!);

    const found = (await listFindings()).filter(f => f.fingerprint === FINGERPRINT);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      status: 'active',
      firstSeenAt: '2026-01-02T03:04:05.000Z',
      timesSeen: 9,
      evidence: EVIDENCE,
      rows: [EVIDENCE],
    });
    expect((await loadSuppressions()).filter(s => s.fingerprint === FINGERPRINT)).toEqual([
      expect.objectContaining({ id: 'pg-rows-sup', reason: 'Accepted risk' }),
    ]);

    // Nothing was rewritten: the column exists and stays empty until the finding's next scan.
    const raw = await pgDb!.execute(sql.raw(`SELECT evidence_rows FROM findings WHERE fingerprint = '${FINGERPRINT}'`));
    expect(raw.rows).toEqual([{ evidence_rows: null }]);
  });
});
