/**
 * Issue #180 on Postgres: a database bootstrapped before "Include advisories" existed has a
 * `notification_channels` table without the column. `bootstrapPg` adds it on the next start, every
 * existing channel keeps its full config and reads back off, and a later start does not reset a
 * setting someone turned on. Postgres-only: the SQLite side is db-migrations-channel-advisories.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { dbReady, pgDb } from '@/lib/db/client';
import { bootstrapPg } from '@/lib/db/pg/bootstrap';

const EMAIL_CONFIG = JSON.stringify({
  host: 'smtp.example.com', port: 587, tls: 'starttls', username: 'ops',
  fromAddress: 'rulebeat@example.com', toAddresses: 'a@example.com, b@example.com',
});

async function rows(q: string): Promise<Record<string, unknown>[]> {
  return (await pgDb!.execute(sql.raw(q))).rows as Record<string, unknown>[];
}

describe.runIf(process.env.RULEBEAT_TEST_PG_URL)('postgres bootstrap adds Include advisories to channels', () => {
  it('keeps every channel and its config, reads each back as off, and leaves a turned-on setting alone', async () => {
    await dbReady;
    await pgDb!.execute(sql`DELETE FROM notification_channels`);
    await pgDb!.execute(sql.raw(`ALTER TABLE notification_channels DROP COLUMN IF EXISTS include_advisories`));
    await pgDb!.execute(sql`
      INSERT INTO notification_channels (id, name, type, url, config, created_at, updated_at, last_notified_at, last_error)
      VALUES
        ('ch-hook', 'Security hook', 'teams', 'v1:ciphertext-hook', NULL, '2026-01-02T03:04:05.000Z', '2026-02-03T04:05:06.000Z', '2026-02-03T04:05:06.000Z', NULL),
        ('ch-mail', 'Ops mail', 'email', 'v1:ciphertext-password', ${EMAIL_CONFIG}, '2026-01-02T03:04:05.000Z', '2026-02-03T04:05:06.000Z', NULL, 'SMTP refused')
    `);

    await bootstrapPg(pgDb!);

    expect(await rows(`SELECT * FROM notification_channels ORDER BY id`)).toEqual([
      {
        id: 'ch-hook', name: 'Security hook', type: 'teams', url: 'v1:ciphertext-hook', config: null,
        created_at: '2026-01-02T03:04:05.000Z', updated_at: '2026-02-03T04:05:06.000Z',
        last_notified_at: '2026-02-03T04:05:06.000Z', last_error: null, include_advisories: false,
      },
      {
        id: 'ch-mail', name: 'Ops mail', type: 'email', url: 'v1:ciphertext-password', config: EMAIL_CONFIG,
        created_at: '2026-01-02T03:04:05.000Z', updated_at: '2026-02-03T04:05:06.000Z',
        last_notified_at: null, last_error: 'SMTP refused', include_advisories: false,
      },
    ]);

    await pgDb!.execute(sql`UPDATE notification_channels SET include_advisories = TRUE WHERE id = 'ch-mail'`);
    await bootstrapPg(pgDb!);
    expect(await rows(`SELECT id, include_advisories FROM notification_channels ORDER BY id`)).toEqual([
      { id: 'ch-hook', include_advisories: false },
      { id: 'ch-mail', include_advisories: true },
    ]);
  });
});
