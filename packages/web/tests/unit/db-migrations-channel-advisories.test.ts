/**
 * Issue #180: the upgrade that adds "Include advisories" to notification channels must leave every
 * existing channel exactly as it was, with the setting off. "It ran without throwing" proves nothing
 * here, because migrations swallow their own errors; these tests read the channels back: name, type,
 * encrypted secret, email config, delivery state and the schedule links that point at them.
 *
 * A database from before the column is made the honest way: the current schema with the column
 * taken off again, since a SQLite file cannot be built from an older release's code.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { makeSample, open, upgradeInProcess } from '../fixtures/upgrade';
import { runMigrations } from '@/lib/db/migrate';

let sqlite: Database.Database | undefined;
afterEach(() => { sqlite?.close(); sqlite = undefined; });

const all = (db: Database.Database, sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as Record<string, unknown>[];

const EMAIL_CONFIG = JSON.stringify({
  host: 'smtp.example.com', port: 587, tls: 'starttls', username: 'ops',
  fromAddress: 'rulebeat@example.com', toAddresses: 'a@example.com, b@example.com',
});

/** An install from before #180: two channels, one linked to a schedule, no include_advisories column. */
function buildBeforeTheColumn() {
  const sample = makeSample('current');
  const db = open(sample.file);
  runMigrations(db);
  const hasColumn = all(db, `PRAGMA table_info(notification_channels)`).some(c => c.name === 'include_advisories');
  if (hasColumn) db.exec(`ALTER TABLE notification_channels DROP COLUMN include_advisories`);
  const insert = db.prepare(`
    INSERT INTO notification_channels (id, name, type, url, config, created_at, updated_at, last_notified_at, last_error)
    VALUES (?, ?, ?, ?, ?, '2026-01-02T03:04:05.000Z', '2026-02-03T04:05:06.000Z', ?, ?)
  `);
  insert.run('ch-hook', 'Security hook', 'teams', 'v1:ciphertext-hook', null, '2026-02-03T04:05:06.000Z', null);
  insert.run('ch-mail', 'Ops mail', 'email', 'v1:ciphertext-password', EMAIL_CONFIG, null, 'SMTP refused');
  db.prepare(`
    INSERT INTO schedule_notification_channels (schedule_id, channel_id, min_severity, category_ids, subscription_ids)
    VALUES ('sched-1', 'ch-hook', 'medium', '["security"]', NULL)
  `).run();
  db.close();
  return sample;
}

describe('upgrading channels to the Include advisories setting', () => {
  it('keeps every channel with its full config and reads each back as off', () => {
    const sample = buildBeforeTheColumn();

    upgradeInProcess(sample);

    sqlite = open(sample.file);
    expect(all(sqlite, `SELECT * FROM notification_channels ORDER BY id`)).toEqual([
      {
        id: 'ch-hook', name: 'Security hook', type: 'teams', url: 'v1:ciphertext-hook', config: null,
        created_at: '2026-01-02T03:04:05.000Z', updated_at: '2026-02-03T04:05:06.000Z',
        last_notified_at: '2026-02-03T04:05:06.000Z', last_error: null, include_advisories: 0,
      },
      {
        id: 'ch-mail', name: 'Ops mail', type: 'email', url: 'v1:ciphertext-password', config: EMAIL_CONFIG,
        created_at: '2026-01-02T03:04:05.000Z', updated_at: '2026-02-03T04:05:06.000Z',
        last_notified_at: null, last_error: 'SMTP refused', include_advisories: 0,
      },
    ]);
    expect(all(sqlite, `SELECT * FROM schedule_notification_channels`)).toEqual([
      { schedule_id: 'sched-1', channel_id: 'ch-hook', min_severity: 'medium', category_ids: '["security"]', subscription_ids: null },
    ]);
  });

  it('does not switch the setting off again on a restart once someone has turned it on', () => {
    const sample = buildBeforeTheColumn();
    upgradeInProcess(sample);
    let db = open(sample.file);
    db.prepare(`UPDATE notification_channels SET include_advisories = 1 WHERE id = 'ch-mail'`).run();
    db.close();

    upgradeInProcess(sample);

    db = sqlite = open(sample.file);
    expect(all(db, `SELECT id, include_advisories FROM notification_channels ORDER BY id`)).toEqual([
      { id: 'ch-hook', include_advisories: 0 },
      { id: 'ch-mail', include_advisories: 1 },
    ]);
  });
});
