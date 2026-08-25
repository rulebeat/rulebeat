// Codifies the footer-drift bug as a test, per "every bug found by hand becomes an automated test
// before it is closed". The regression fixture below is built from the real file's shape at the
// moment it was broken: [Unreleased] still comparing from v0.1.0 after 0.2.0 shipped, with 0.2.0
// having no footer link of its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { checkChangelogStructure } from './check-changelog-structure.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const URL_BASE = 'https://github.com/rulebeat/rulebeat';

/** A minimal, correct changelog. Each test below breaks exactly one thing about it. */
function wellFormed() {
  return [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '## [0.2.0] - 2026-08-24',
    '',
    '### Fixed',
    '- Something.',
    '',
    '## [0.1.0] - 2026-08-22',
    '',
    'First release.',
    '',
    `[Unreleased]: ${URL_BASE}/compare/v0.2.0...HEAD`,
    `[0.2.0]: ${URL_BASE}/compare/v0.1.0...v0.2.0`,
    `[0.1.0]: ${URL_BASE}/releases/tag/v0.1.0`,
    '',
  ].join('\n');
}

test('a well-formed changelog passes', () => {
  assert.deepEqual(checkChangelogStructure(wellFormed()), { ok: true, errors: [] });
});

test("the repo's own real CHANGELOG.md passes -- this one is the canary", () => {
  const real = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
  const result = checkChangelogStructure(real);
  assert.deepEqual(result.errors, [], 'the live CHANGELOG must satisfy its own invariants');
});

test('THE REGRESSION: [Unreleased] left pointing at an older version fails', () => {
  // Exactly the state the file was in after 0.2.0 shipped, before updateChangelogFooterLinks().
  const broken = wellFormed()
    .replace(`[Unreleased]: ${URL_BASE}/compare/v0.2.0...HEAD`, `[Unreleased]: ${URL_BASE}/compare/v0.1.0...HEAD`)
    .replace(`[0.2.0]: ${URL_BASE}/compare/v0.1.0...v0.2.0\n`, '');
  const result = checkChangelogStructure(broken);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /\[Unreleased\] points at .*v0\.1\.0\.\.\.HEAD.*newest release is 0\.2\.0/s);
  assert.match(result.errors.join('\n'), /Release 0\.2\.0 has a header but no "\[0\.2\.0\]:" footer link/);
});

test('a header with no footer link fails, naming the version', () => {
  const broken = wellFormed().replace(`[0.1.0]: ${URL_BASE}/releases/tag/v0.1.0\n`, '');
  const result = checkChangelogStructure(broken);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /Release 0\.1\.0 has a header but no/);
});

test('a footer link pointing at the wrong target fails', () => {
  const broken = wellFormed().replace(
    `[0.2.0]: ${URL_BASE}/compare/v0.1.0...v0.2.0`,
    `[0.2.0]: ${URL_BASE}/compare/v0.0.9...v0.2.0`
  );
  const result = checkChangelogStructure(broken);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /\[0\.2\.0\] points at .*v0\.0\.9/);
});

test('the oldest release must use releases/tag, not compare', () => {
  const broken = wellFormed().replace(
    `[0.1.0]: ${URL_BASE}/releases/tag/v0.1.0`,
    `[0.1.0]: ${URL_BASE}/compare/v0.0.1...v0.1.0`
  );
  assert.equal(checkChangelogStructure(broken).ok, false);
});

test('an orphan footer link fails', () => {
  const broken = wellFormed().replace(
    `[0.1.0]: ${URL_BASE}/releases/tag/v0.1.0`,
    `[0.1.0]: ${URL_BASE}/releases/tag/v0.1.0\n[0.9.9]: ${URL_BASE}/releases/tag/v0.9.9`
  );
  const result = checkChangelogStructure(broken);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /\[0\.9\.9\] has no matching/);
});

test('a duplicated footer definition fails', () => {
  const broken = wellFormed().replace(
    `[0.2.0]: ${URL_BASE}/compare/v0.1.0...v0.2.0`,
    `[0.2.0]: ${URL_BASE}/compare/v0.1.0...v0.2.0\n[0.2.0]: ${URL_BASE}/compare/v0.1.0...v0.2.0`
  );
  const result = checkChangelogStructure(broken);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /defined 2 times/);
});

test('duplicate release headers fail', () => {
  const broken = wellFormed().replace(
    '## [0.1.0] - 2026-08-22',
    '## [0.2.0] - 2026-08-23\n\n## [0.1.0] - 2026-08-22'
  );
  const result = checkChangelogStructure(broken);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /Duplicate release header for 0\.2\.0/);
});

test('releases out of semver order fail, and ONLY for that reason', () => {
  // Built rather than string-replaced, so ordering is the single thing wrong. Every footer link
  // matches the order the headers are actually in, and the dates descend, so a lazier fixture that
  // happened to break duplicates or footers too would not prove this rule fires at all.
  const ascending = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '## [0.1.0] - 2026-08-24',
    '',
    '## [0.2.0] - 2026-08-22',
    '',
    `[Unreleased]: ${URL_BASE}/compare/v0.1.0...HEAD`,
    `[0.1.0]: ${URL_BASE}/compare/v0.2.0...v0.1.0`,
    `[0.2.0]: ${URL_BASE}/releases/tag/v0.2.0`,
    '',
  ].join('\n');

  const result = checkChangelogStructure(ascending);
  assert.deepEqual(result.errors, [
    'Release headers must run newest first: 0.1.0 appears above 0.2.0.',
  ]);
});

test('an impossible calendar date fails even though it matches YYYY-MM-DD', () => {
  const broken = wellFormed().replace('2026-08-24', '2026-02-30');
  const result = checkChangelogStructure(broken);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /not a real YYYY-MM-DD calendar date/);
});

test('dates increasing down the file fail', () => {
  const broken = wellFormed().replace('## [0.1.0] - 2026-08-22', '## [0.1.0] - 2026-12-31');
  const result = checkChangelogStructure(broken);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /Release dates must not increase down the file/);
});

test('a release header with no date at all fails', () => {
  const broken = wellFormed().replace('## [0.2.0] - 2026-08-24', '## [0.2.0]');
  const result = checkChangelogStructure(broken);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /has no date/);
});

test('a header that only LOOKS like a release is reported, not silently skipped', () => {
  // "## [0.2]" would otherwise fall through every check below it, taking its entry with it.
  const broken = wellFormed().replace('## [0.2.0] - 2026-08-24', '## [0.2] - 2026-08-24');
  const result = checkChangelogStructure(broken);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /looks like a release header but does not match/);
});

test('a missing or duplicated [Unreleased] header fails', () => {
  assert.equal(checkChangelogStructure(wellFormed().replace('## [Unreleased]\n\n', '')).ok, false);
  const twice = wellFormed().replace('## [Unreleased]', '## [Unreleased]\n\n## [Unreleased]');
  assert.match(checkChangelogStructure(twice).errors.join('\n'), /there must be one/);
});

test('every problem is reported at once, not just the first', () => {
  const broken = wellFormed()
    .replace(`[0.1.0]: ${URL_BASE}/releases/tag/v0.1.0\n`, '')
    .replace('2026-08-24', '2026-02-30');
  const result = checkChangelogStructure(broken);
  assert.ok(result.errors.length >= 2, `expected several errors, got ${result.errors.join(' | ')}`);
});

test('the CLI reports version AND structural errors together', () => {
  // verify-release-version.mjs runs in both tag-release.yml and publish-image.yml, so wiring the
  // structural check into its main() gates tagging and promotion with no workflow changes.
  let stderr = '';
  try {
    execFileSync('node', [resolve(root, 'scripts/verify-release-version.mjs'), 'v9.9.9'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.fail('expected a non-zero exit for a tag that does not match this repo');
  } catch (err) {
    stderr = `${err.stderr ?? ''}${err.stdout ?? ''}`;
    assert.equal(err.status, 1);
  }
  assert.match(stderr, /9\.9\.9/, 'the version mismatch must be reported');
});
