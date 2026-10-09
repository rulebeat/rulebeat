/**
 * Ticket #165 (spec #152, ADR 0004): the pack sync gives each rule its own version. The versioning
 * step is a pure function over the previous pack file and the freshly fetched rules, so it is driven
 * here with two fixture snapshots and no network.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { versionPackRules, type PackFileRule } from '@/lib/pack-versioning';
import { loadShippedCatalogue, syncedFromCommitNote } from '@/lib/shipped-catalogue';
import previousSnapshot from '../fixtures/pack-sync/previous.json';
import nextSnapshot from '../fixtures/pack-sync/next.json';

const PINNED = '2026-09-14T08:30:00Z';
const PINNED_COMMIT = '9999999999999999999999999999999999999999';
const ENTERPRISE = '11111111-0000-4000-8000-000000000001';
const REPLICA = '11111111-0000-4000-8000-000000000002';
const STRETCHED = '11111111-0000-4000-8000-000000000003';
const DROPPED = '11111111-0000-4000-8000-000000000004';
const ADDED = '11111111-0000-4000-8000-000000000005';

const previous = previousSnapshot as PackFileRule[];
const next = nextSnapshot as PackFileRule[];

function sync(prev: PackFileRule[] = previous, fresh: PackFileRule[] = next) {
  return versionPackRules({ previous: prev, next: fresh, pinnedCommitDate: PINNED, pinnedCommit: PINNED_COMMIT });
}
function entry(rules: PackFileRule[], id: string): PackFileRule {
  const found = rules.find(r => r.id === id);
  if (!found) throw new Error(`no rule ${id} in the result`);
  return found;
}

describe('versioning a synced pack against its previous file', () => {
  it('keeps the version, note and upstream commit of a rule whose definition did not change', () => {
    const { rules } = sync();
    expect(entry(rules, ENTERPRISE)).toMatchObject({
      version: '2026-05-01T10:00:00Z',
      releaseNote: 'Added to the pack.',
      upstreamRef: '1111111111111111111111111111111111111111',
    });
  });

  it('gives a changed rule the pinned commit date, its commit, and a note naming the changed fields', () => {
    const { rules } = sync();
    expect(entry(rules, REPLICA)).toMatchObject({
      version: PINNED,
      releaseNote: 'Changed: severity, query.',
      upstreamRef: PINNED_COMMIT,
    });
  });

  it('treats a change to a field outside the definition, or to key order, as no change', () => {
    // The fixture flips `enabled` and reorders every key of this rule.
    const { rules } = sync();
    expect(entry(rules, STRETCHED)).toMatchObject({ version: '2026-05-01T10:00:00Z', releaseNote: 'Added to the pack.' });
    // The pack's own value for the flag still wins over the previous file's.
    expect(entry(rules, STRETCHED).enabled).toBe(true);
  });

  it('versions a rule that is new to the pack at the pinned commit date', () => {
    const { rules } = sync();
    expect(entry(rules, ADDED)).toMatchObject({ version: PINNED, releaseNote: 'Added to the pack.', upstreamRef: PINNED_COMMIT });
  });

  it('leaves out a rule upstream dropped, and reports it', () => {
    const { rules, summary } = sync();
    expect(rules.map(r => r.id)).not.toContain(DROPPED);
    expect(summary).toEqual({ unchanged: [ENTERPRISE, STRETCHED], changed: [REPLICA], added: [ADDED], dropped: [DROPPED] });
  });

  it('keeps the order of the freshly fetched rules and does not touch the rest of an entry', () => {
    const { rules } = sync();
    expect(rules.map(r => r.id)).toEqual([ENTERPRISE, REPLICA, STRETCHED, ADDED]);
    expect(entry(rules, REPLICA).rawKql).toBe(entry(next, REPLICA).rawKql);
  });

  it('is stable: syncing the same commit again changes no version', () => {
    const once = sync().rules;
    const twice = sync(once, next).rules;
    expect(twice).toEqual(once);
  });
});

describe('a previous pack file written before rules carried their own version', () => {
  const stripped = previous.map(({ version: _v, releaseNote: _n, upstreamRef: _u, ...rest }) => rest as PackFileRule);
  const legacy = { version: '2026-06-08T13:06:47Z', releaseNote: 'Synced from upstream commit 1824eb5.', upstreamRef: '1824eb5958d11482f6e23c231f0cb1d2d5bd44f6' };

  it('keeps an unchanged rule on the pack version that file shipped under, so 4 rules do not all become new', () => {
    const { rules, summary } = versionPackRules({
      previous: stripped, next, pinnedCommitDate: PINNED, pinnedCommit: PINNED_COMMIT, previousPackDefaults: legacy,
    });
    expect(entry(rules, ENTERPRISE)).toMatchObject(legacy);
    expect(entry(rules, REPLICA).version).toBe(PINNED);
    expect(summary.changed).toEqual([REPLICA]);
  });

  it('refuses to guess a version for an unchanged rule when it has none and no default was given', () => {
    expect(() => versionPackRules({ previous: stripped, next, pinnedCommitDate: PINNED, pinnedCommit: PINNED_COMMIT }))
      .toThrow(/no version/i);
  });
});

describe('the note a sync gives a version it can only name by commit', () => {
  it('is one sentence built in one place, naming the first 7 characters of the commit', () => {
    expect(syncedFromCommitNote('1824eb5958d11482f6e23c231f0cb1d2d5bd44f6')).toBe('Synced from upstream commit 1824eb5.');
  });

  it('treats an empty note or upstream commit on an unchanged entry as absent', () => {
    const blank = previous.map(r => r.id === ENTERPRISE ? { ...r, releaseNote: '', upstreamRef: '' } : r);
    const { rules } = versionPackRules({ previous: blank, next, pinnedCommitDate: PINNED, pinnedCommit: PINNED_COMMIT });
    const kept = entry(rules, ENTERPRISE);
    expect(kept.releaseNote).toBe(`Version ${kept.version}.`);
    expect(kept).not.toHaveProperty('upstreamRef');
  });
});

describe('the loader reads what the sync writes', () => {
  function shipPack(rules: PackFileRule[]): string {
    const dataDir = mkdtempSync(join(tmpdir(), 'rb-pack-versioning-'));
    mkdirSync(join(dataDir, 'packs'));
    writeFileSync(join(dataDir, 'packs', 'fixture-pack.json'), JSON.stringify(rules));
    writeFileSync(join(dataDir, 'packs', 'pack-manifest.json'), JSON.stringify({
      'fixture-pack': { label: 'Fixture pack', versionScheme: 'upstream-commit-date', pinnedCommit: PINNED_COMMIT, pinnedCommitDate: PINNED },
    }));
    return dataDir;
  }
  const shipped = (rules: PackFileRule[], id: string) => {
    const found = loadShippedCatalogue(shipPack(rules)).rules.find(r => r.id === id);
    if (!found) throw new Error(`catalogue has no ${id}`);
    return found;
  };

  it('ships each rule under its own version, note and upstream commit', () => {
    const rules = sync().rules;
    expect(shipped(rules, ENTERPRISE)).toMatchObject({
      version: '2026-05-01T10:00:00Z', releaseNote: 'Added to the pack.', upstreamRef: '1111111111111111111111111111111111111111',
    });
    expect(shipped(rules, REPLICA)).toMatchObject({ version: PINNED, releaseNote: 'Changed: severity, query.', upstreamRef: PINNED_COMMIT });
  });

  it('still ships a rule with no version of its own under the pack version from the manifest', () => {
    expect(shipped(previous.map(({ version: _v, releaseNote: _n, upstreamRef: _u, ...rest }) => rest as PackFileRule), ENTERPRISE))
      .toMatchObject({ version: PINNED, upstreamRef: PINNED_COMMIT, releaseNote: 'Synced from upstream commit 9999999.' });
  });
});

describe('a kind RuleBeat declared on a pack rule (#186)', () => {
  // Upstream never says whether a rule is an Advisory; RuleBeat adds `kind` to the pack file by hand.
  const declared = previous.map(r => r.id === ENTERPRISE ? { ...r, kind: 'advisory' } : r);

  it('survives a sync, so the rule is not shipped back as a Problem', () => {
    const { rules } = sync(declared, next);
    expect(entry(rules, ENTERPRISE).kind).toBe('advisory');
  });

  it('is not a change of definition, so the rule keeps its version', () => {
    const { rules, summary } = sync(declared, next);
    expect(entry(rules, ENTERPRISE).version).toBe('2026-05-01T10:00:00Z');
    expect(summary.unchanged).toContain(ENTERPRISE);
  });

  it('gives way to a kind the fetched entry declares itself', () => {
    const fresh = next.map(r => r.id === ENTERPRISE ? { ...r, kind: 'state' } : r);
    const { rules } = sync(declared, fresh);
    expect(entry(rules, ENTERPRISE).kind).toBe('state');
  });
});
