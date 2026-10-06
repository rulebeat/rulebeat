/**
 * What this build actually ships (ticket #163): the committed Core definitions and pack files,
 * read through `loadShippedCatalogue()` the way startup reads them. A pack that loses its manifest
 * version would otherwise be skipped quietly at startup, so the real data is pinned here.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadShippedCatalogue } from '@/lib/shipped-catalogue';

const REAL_DATA_DIR = join(resolve(__dirname, '..', '..'), 'data');

describe('the shipped catalogue', () => {
  const catalogue = loadShippedCatalogue(REAL_DATA_DIR);

  it('ships every RuleBeat Core rule at 1.0.0 with a release note', () => {
    const core = catalogue.rules.filter(r => r.pack === 'rulebeat-core');
    expect(core.length).toBeGreaterThan(0);
    for (const r of core) {
      expect(r.versionScheme).toBe('semver');
      expect(r.version).toBe('1.0.0');
      expect(r.releaseNote).not.toBe('');
    }
  });

  it('ships every APRL rule under the upstream commit timestamp, with the commit as its reference', () => {
    const aprl = catalogue.rules.filter(r => r.pack === 'aprl-v2');
    expect(aprl).toHaveLength(143);
    for (const r of aprl) {
      expect(r.versionScheme).toBe('upstream-commit-date');
      expect(r.version).toBe('2026-06-08T13:06:47Z');
      expect(r.upstreamRef).toBe('1824eb5958d11482f6e23c231f0cb1d2d5bd44f6');
    }
    expect(catalogue.unreadablePacks).toEqual([]);
    expect(catalogue.packsDirRead).toBe(true);
  });

  it('skips a pack the manifest gives no version, and says it was unreadable rather than dropped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rb-catalogue-'));
    mkdirSync(join(dir, 'packs'));
    writeFileSync(join(dir, 'packs', 'pack-manifest.json'), JSON.stringify({ 'no-version': { label: 'X' } }));
    writeFileSync(join(dir, 'packs', 'no-version.json'), JSON.stringify([{ id: 'r1', name: 'n', description: 'd', category: 'c', severity: 'low' }]));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = loadShippedCatalogue(dir);
      expect(result.rules.some(r => r.pack === 'no-version')).toBe(false);
      expect(result.unreadablePacks).toEqual(['no-version']);
      expect(result.packsDirRead).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('reads the scheme RuleBeat Core ships under from the manifest, and falls back to semver without one', () => {
    const declared = mkdtempSync(join(tmpdir(), 'rb-catalogue-'));
    mkdirSync(join(declared, 'packs'));
    writeFileSync(join(declared, 'packs', 'pack-manifest.json'), JSON.stringify({ 'rulebeat-core': { label: 'Core', versionScheme: 'upstream-release' } }));
    const core = loadShippedCatalogue(declared).rules.filter(r => r.pack === 'rulebeat-core');
    expect(core.length).toBeGreaterThan(0);
    for (const r of core) expect(r.versionScheme).toBe('upstream-release');

    const absent = mkdtempSync(join(tmpdir(), 'rb-catalogue-'));
    for (const r of loadShippedCatalogue(absent).rules.filter(x => x.pack === 'rulebeat-core')) {
      expect(r.versionScheme).toBe('semver');
    }
  });
});
