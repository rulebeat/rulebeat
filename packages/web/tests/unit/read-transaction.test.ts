/**
 * ADR 0007: a view is answered from several reads that must agree, so they run in one
 * read transaction: a snapshot on Postgres (REPEATABLE READ), the connection held by the same lock a
 * write transaction takes on SQLite. Both backends are held to the same behaviour here: whatever
 * commits while the transaction is open is not seen by the reads still to come.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db/client';
import { many, inReadTransaction, inTransaction, run } from '@/lib/db/exec';
import { suppressions as suppressionsTable } from '@/lib/db/tables';
import { addSuppression } from '@/lib/suppressions';
import { resetDb } from '../helpers/db';

const suppression = (id: string) => ({ id, fingerprint: `fp-${id}`, reason: 'test', suppressedAt: '2026-10-09T00:00:00.000Z' });
const count = async (handle: typeof db) => (await many(handle.select().from(suppressionsTable))).length;
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

beforeEach(async () => { await resetDb(); });

describe('inReadTransaction', () => {
  it('hands the callback a handle that reads, and returns what the callback returns', async () => {
    await addSuppression(suppression('one'));
    const seen = await inReadTransaction(async (tx) => ({ rows: await count(tx) }));
    expect(seen).toEqual({ rows: 1 });
  });

  it('joins a transaction that is already open instead of opening another', async () => {
    await inTransaction(async (outer) => {
      await run(outer.insert(suppressionsTable).values({ ...suppression('inner'), resourceId: null, expiresAt: null }));
      // Uncommitted rows are visible only on the outer transaction's own handle.
      expect(await inReadTransaction(async (tx) => count(tx))).toBe(1);
    });
  });

  it('does not see what commits while it is open, and the write lands after it', async () => {
    await addSuppression(suppression('before'));
    let firstRead!: () => void;
    const hasRead = new Promise<void>(resolve => { firstRead = resolve; });
    let letGo!: () => void;
    const gate = new Promise<void>(resolve => { letGo = resolve; });

    const reading = inReadTransaction(async (tx) => {
      const first = await count(tx);
      firstRead();
      await gate;
      return [first, await count(tx)];
    });
    // The writer is someone else: it starts outside the read's own async context.
    await hasRead;
    const writing = addSuppression(suppression('during'));
    // On Postgres the write commits at once (a fresh connection can take a moment); on SQLite it waits
    // behind the read, so the wait is bounded.
    await Promise.race([writing, pause(300)]);
    letGo();

    expect(await reading).toEqual([1, 1]);
    await writing;
    expect(await count(db)).toBe(2);
  });
});
