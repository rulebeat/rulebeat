// The release pipeline used to trust a branch name (startsWith(head.ref, 'release/v')) and a
// mutable ref (checkout main). These tests pin down the two replacements: an identity check that a
// fork cannot satisfy, and a candidate check that refuses a release branch which drifted from the
// snapshot it was generated from.
//
// Pure fixtures only -- no git, no GitHub payload -- matching verify-release-version.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  classifyReleasePr,
  checkReleaseCandidate,
  newestReleasedHeader,
  unreleasedSectionLines,
  RELEASE_FILES,
} from './check-release-candidate.mjs';
import { bumpChangelog, updateChangelogFooterLinks } from './release.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const LEGIT = Object.freeze({
  headRef: 'release/v0.3.0',
  headRepoFullName: 'rulebeat/rulebeat',
  repository: 'rulebeat/rulebeat',
  author: 'github-actions[bot]',
  packageVersion: '0.3.0',
});

// ---------------------------------------------------------------- identity

test('an ordinary PR is classified not-release, and is skipped rather than failed', () => {
  const result = classifyReleasePr({ ...LEGIT, headRef: 'fix/some-bug' });
  assert.equal(result.kind, 'not-release');
  assert.deepEqual(result.errors, []);
});

test('a genuine release PR is valid and reports its version', () => {
  const result = classifyReleasePr(LEGIT);
  assert.equal(result.kind, 'valid');
  assert.equal(result.version, '0.3.0');
});

test('a fork branch named release/v0.3.0 is invalid, not skipped', () => {
  // The whole point: the branch name is attacker-chosen, so it cannot be the identity.
  const result = classifyReleasePr({ ...LEGIT, headRepoFullName: 'attacker/rulebeat' });
  assert.equal(result.kind, 'invalid');
  assert.match(result.errors.join('\n'), /must live in rulebeat\/rulebeat/);
});

test('a release-shaped branch from an unexpected author is invalid', () => {
  const result = classifyReleasePr({ ...LEGIT, author: 'someone-else' });
  assert.equal(result.kind, 'invalid');
  assert.match(result.errors.join('\n'), /opened by github-actions\[bot\]/);
});

test('a release-shaped but malformed branch name is invalid, never not-release', () => {
  for (const headRef of ['release/v1.2', 'release/vX.Y.Z', 'release/nonsense', 'release/v1.2.3.4']) {
    const result = classifyReleasePr({ ...LEGIT, headRef });
    assert.equal(result.kind, 'invalid', `${headRef} should be invalid`);
  }
});

test('a branch whose version disagrees with package.json is invalid', () => {
  const result = classifyReleasePr({ ...LEGIT, packageVersion: '0.4.0' });
  assert.equal(result.kind, 'invalid');
  assert.match(result.errors.join('\n'), /Branch says v0\.3\.0 but package\.json says 0\.4\.0/);
});

// ------------------------------------------------------------- parsing bits

test('unreleasedSectionLines stops at the next release header', () => {
  const text = '# C\n\n## [Unreleased]\n\n- pending\n\n## [0.1.0] - 2026-08-22\n\n- shipped\n';
  const lines = unreleasedSectionLines(text);
  assert.ok(lines.join('\n').includes('- pending'));
  assert.ok(!lines.join('\n').includes('- shipped'), 'must not read the released section');
});

test('unreleasedSectionLines returns null when there is no [Unreleased] header', () => {
  assert.equal(unreleasedSectionLines('# C\n\n## [0.1.0] - 2026-08-22\n'), null);
});

test('newestReleasedHeader picks the first released header, ignoring [Unreleased]', () => {
  const text = '## [Unreleased]\n\n## [0.2.1] - 2026-08-24\n\n## [0.2.0] - 2026-08-24\n';
  assert.deepEqual(newestReleasedHeader(text), { version: '0.2.1', date: '2026-08-24' });
});

// --------------------------------------------------------------- candidate

const GOOD_CHANGELOG = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '## [0.3.0] - 2026-09-01',
  '',
  '### Fixed',
  '- A real fix.',
  '',
  '## [0.2.1] - 2026-08-24',
  '',
].join('\n');

const GOOD_INPUT = Object.freeze({
  changelogText: GOOD_CHANGELOG,
  packageVersions: {
    'package.json': '0.3.0',
    'packages/core/package.json': '0.3.0',
    'packages/web/package.json': '0.3.0',
  },
  version: '0.3.0',
  changedPaths: [...RELEASE_FILES],
});

test('a well-formed release candidate passes', () => {
  assert.deepEqual(checkReleaseCandidate(GOOD_INPUT), { ok: true, errors: [] });
});

test('a manifest disagreeing with the release version fails, naming the file', () => {
  const result = checkReleaseCandidate({
    ...GOOD_INPUT,
    packageVersions: { ...GOOD_INPUT.packageVersions, 'packages/web/package.json': '0.2.1' },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /packages\/web\/package\.json says version "0\.2\.1"/);
});

test('a newest changelog header that is not this version fails', () => {
  const result = checkReleaseCandidate({ ...GOOD_INPUT, version: '0.4.0' });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /newest release header is \[0\.3\.0\]/);
});

test('a NON-EMPTY [Unreleased] at the tagged commit fails -- the stale-release-branch case', () => {
  // This is the v0.2.0 near-miss: main moved while the release branch was open, the merge brought a
  // new [Unreleased] bullet along, and it would have shipped in this release unrecorded.
  const drifted = GOOD_CHANGELOG.replace(
    '## [Unreleased]\n',
    '## [Unreleased]\n\n### Fixed\n- Landed after the release was prepared.\n'
  );
  const result = checkReleaseCandidate({ ...GOOD_INPUT, changelogText: drifted });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /not empty at this commit \(1 entry\)/);
  assert.match(result.errors.join('\n'), /Regenerate the release from the current base/);
});

test('a release branch that also changed product code fails, naming the file', () => {
  const result = checkReleaseCandidate({
    ...GOOD_INPUT,
    changedPaths: [...RELEASE_FILES, 'packages/web/lib/db/migrate.ts'],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /it also changed: packages\/web\/lib\/db\/migrate\.ts/);
});

test('a release branch changing only some of the release files still passes', () => {
  // release.mjs always writes all five, but a subset is not evidence of tampering -- only extra
  // files are. Pinning this stops a future "must equal exactly" tightening from breaking releases.
  const result = checkReleaseCandidate({ ...GOOD_INPUT, changedPaths: ['CHANGELOG.md'] });
  assert.equal(result.ok, true);
});

test('a missing [Unreleased] header is reported, not thrown', () => {
  const result = checkReleaseCandidate({
    ...GOOD_INPUT,
    changelogText: '# Changelog\n\n## [0.3.0] - 2026-09-01\n\n- x\n',
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /no "## \[Unreleased\]" header/);
});

test('every error is collected at once, not just the first', () => {
  const result = checkReleaseCandidate({
    ...GOOD_INPUT,
    packageVersions: { 'package.json': '9.9.9' },
    changedPaths: ['Dockerfile'],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 2, `expected several errors, got ${result.errors.length}`);
});

test("the repo's own real CHANGELOG.md parses, and its shipped state matches package.json", () => {
  const real = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
  const newest = newestReleasedHeader(real);
  assert.ok(newest, 'the real CHANGELOG must have a released header');

  const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
  assert.equal(newest.version, version, 'real CHANGELOG newest header must match real package.json');
});

test('what release.mjs actually produces from the real CHANGELOG is a valid candidate', () => {
  // Deliberately NOT "the real CHANGELOG is a valid candidate" -- during normal development
  // [Unreleased] has content, and a candidate is only valid once bumpChangelog() has emptied it.
  // Asserting on the live file would have meant a test that goes red the moment anyone records a
  // change, which is the opposite of what this checks. Running the real release transformation
  // here instead also proves the checker and bumpChangelog() agree about the shape of a release.
  const real = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
  const previous = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
  const next = '99.0.0';

  const released = updateChangelogFooterLinks(
    bumpChangelog(real, next, '2026-09-01'),
    previous,
    next
  );

  const result = checkReleaseCandidate({
    changelogText: released,
    packageVersions: {
      'package.json': next,
      'packages/core/package.json': next,
      'packages/web/package.json': next,
    },
    version: next,
    changedPaths: [...RELEASE_FILES],
  });
  assert.deepEqual(result.errors, []);
});

test('the real CHANGELOG BEFORE a release is correctly not a valid candidate when work is pending', () => {
  const real = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
  const pending = real.replace(
    '## [Unreleased]\n',
    '## [Unreleased]\n\n### Fixed\n- Something recorded but not yet released.\n'
  );
  const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;

  const result = checkReleaseCandidate({
    changelogText: pending,
    packageVersions: { 'package.json': version },
    version,
    changedPaths: ['CHANGELOG.md'],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /not empty at this commit/);
});
