/**
 * B3 · onboarding marker — the phase-4 gate.
 *
 * The whole feature hinges on one distinction: a genuinely brand-new install (no users yet) must
 * see the setup wizard, and every existing install (upgrading from a version that predates it) must
 * never be redirected there. Getting this backwards would trap every real customer's admin in a
 * wizard on their next page load, which would break this project's standing rule that an upgrade
 * must never disturb a user's configuration or settings.
 *
 * `getOnboardingState()`'s tolerant parse is tested against the *live* db (via `setMeta` directly),
 * not a sample file — `resetDb()` deliberately never clears `meta`, so this is the one state a test
 * has to set up explicitly rather than inherit from a clean slate.
 */
import { describe, expect, it } from 'vitest';
import { getMeta, setMeta } from '@/lib/db/meta';
import { getOnboardingState, setOnboardingState } from '@/lib/onboarding';
import { openDatabase, runMigrations, runSeeds } from '@/lib/db/migrate';
import { makeSample, open, upgradeInProcess } from '../fixtures/upgrade';
import { addUsers } from '../fixtures/db-shapes';

function onboardingRow(sqlite: ReturnType<typeof open>): { status: string } | null {
  const row = sqlite.prepare(`SELECT value FROM meta WHERE key = 'onboarding-v1'`).get() as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as { status: string }) : null;
}

describe('B3 · onboarding-v1 seeding', () => {
  it('a genuinely fresh install (zero users) starts pending', () => {
    const sample = makeSample('current');
    upgradeInProcess(sample);
    const sqlite = open(sample.file);
    try {
      expect(onboardingRow(sqlite)?.status).toBe('pending');
    } finally {
      sqlite.close();
    }
  });

  it('a database that already has users is skipped, never pending', () => {
    const sample = makeSample('current');
    addUsers(sample.file);
    upgradeInProcess(sample);
    const sqlite = open(sample.file);
    try {
      expect(onboardingRow(sqlite)?.status).toBe('skipped');
    } finally {
      sqlite.close();
    }
  });

  it('re-seeding never mutates an already-decided value', () => {
    const sample = makeSample('current');
    upgradeInProcess(sample);

    // Simulate the admin having finished the wizard, then re-run seeding the way every restart does.
    const sqlite = openDatabase(sample.file);
    sqlite.prepare(`UPDATE meta SET value = ? WHERE key = 'onboarding-v1'`).run(
      JSON.stringify({ status: 'done', lastStep: 4, completedAt: '2026-08-01T00:00:00.000Z', completedBy: 'admin@rulebeat.local' }),
    );
    runMigrations(sqlite);
    runSeeds(sqlite, sample.dataDir);
    const after = onboardingRow(sqlite);
    sqlite.close();

    expect(after?.status).toBe('done');
  });

  it('a malformed stored value degrades to skipped rather than throwing', () => {
    // Tests the tolerant parse in lib/onboarding.ts directly, against the live test db — resetDb()
    // never clears meta, so this state has to be set up explicitly rather than inherited.
    setOnboardingState({ status: 'pending' }); // sanity: writes valid JSON via the normal path first
    expect(getMeta('onboarding-v1')).not.toBeNull();

    // Now corrupt it the way a bare JSON.parse (the deliberate break) would choke on.
    setMeta('onboarding-v1', 'not valid json{');

    expect(() => getOnboardingState()).not.toThrow();
    expect(getOnboardingState().status).toBe('skipped');
  });
});
