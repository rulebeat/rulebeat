// Dependency notes derived from manifests, and the bump inferred from [Unreleased].
//
// The manifest fixtures below are the real v0.2.0 -> v0.2.1 shape: a major bump, a patch bump, and
// a package that exists in both workspaces.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  diffRuntimeDependencies,
  formatDependencyBullets,
  injectDependencyNotes,
} from './release-dependency-notes.mjs';
import { recommendBump, checkOverride, BREAKING_HEADING } from './recommend-bump.mjs';

const core = (deps) => JSON.stringify({ name: '@rulebeat/core', dependencies: deps });
const web = (deps, devDeps) =>
  JSON.stringify({ name: '@rulebeat/web', dependencies: deps, devDependencies: devDeps ?? {} });

const BASE = {
  'packages/core/package.json': core({ '@azure/arm-resourcegraph': '^4.2.0', '@azure/identity': '^4.13.0' }),
  'packages/web/package.json': web({ 'better-sqlite3': '^12.10.0', '@azure/identity': '^4.13.1' }, { vitest: '^4.1.10' }),
};
const HEAD = {
  'packages/core/package.json': core({ '@azure/arm-resourcegraph': '^5.0.0', '@azure/identity': '^4.13.2' }),
  'packages/web/package.json': web({ 'better-sqlite3': '^13.0.3', '@azure/identity': '^4.13.2' }, { vitest: '^4.1.11' }),
};

// ------------------------------------------------------------------ derivation

test('a runtime dependency bump is derived from the manifests', () => {
  const changes = diffRuntimeDependencies(BASE, HEAD);
  const names = changes.map((c) => c.name);
  assert.ok(names.includes('better-sqlite3'));
  assert.ok(names.includes('@azure/arm-resourcegraph'));
});

test('devDependencies are NOT reported -- they are not in the image', () => {
  const changes = diffRuntimeDependencies(BASE, HEAD);
  assert.ok(!changes.some((c) => c.name === 'vitest'), 'vitest is a devDependency');
});

test('a package in both workspaces collapses to one bullet spanning the whole change', () => {
  const changes = diffRuntimeDependencies(BASE, HEAD);
  const identity = changes.filter((c) => c.name === '@azure/identity');
  assert.equal(identity.length, 1, 'must not appear once per workspace');
  assert.equal(identity[0].to, '^4.13.2');
});

test('changes are sorted by package name, so the block is stable run to run', () => {
  const names = diffRuntimeDependencies(BASE, HEAD).map((c) => c.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
});

test('an unchanged manifest yields nothing', () => {
  assert.deepEqual(diffRuntimeDependencies(BASE, BASE), []);
});

test('added and removed dependencies are described as such', () => {
  const before = { 'packages/core/package.json': core({ a: '^1.0.0' }) };
  const after = { 'packages/core/package.json': core({ b: '^2.0.0' }) };
  const bullets = formatDependencyBullets(diffRuntimeDependencies(before, after));
  assert.ok(bullets.some((b) => b.startsWith('Added `b` 2.0.0')));
  assert.ok(bullets.some((b) => b.startsWith('Removed `a`')));
});

test('range prefixes are stripped, because "^9.0.5" is not how a human reads a version', () => {
  const bullets = formatDependencyBullets([{ name: 'nodemailer', from: '^7.0.13', to: '^9.0.5' }]);
  assert.deepEqual(bullets, ['Updated `nodemailer` from 7.0.13 to 9.0.5.']);
});

test('unparseable manifest JSON is survived, not thrown on', () => {
  const changes = diffRuntimeDependencies({ 'packages/core/package.json': '{oops' }, HEAD);
  assert.ok(Array.isArray(changes));
});

// ------------------------------------------------------------------- injection

const EMPTY = '# Changelog\n\n## [Unreleased]\n\n## [0.2.1] - 2026-08-24\n\n- old.\n';
const CHANGES = [{ name: 'better-sqlite3', from: '^12.10.0', to: '^13.0.3' }];

test('nothing to add leaves the file BYTE-IDENTICAL', () => {
  assert.equal(injectDependencyNotes(EMPTY, []), EMPTY);
});

test('a Dependencies block is created under [Unreleased]', () => {
  const out = injectDependencyNotes(EMPTY, CHANGES);
  assert.match(out, /## \[Unreleased\][\s\S]*### Dependencies[\s\S]*better-sqlite3/);
  assert.ok(out.indexOf('### Dependencies') < out.indexOf('## [0.2.1]'), 'must land above the last release');
});

test('injecting twice equals injecting once', () => {
  const once = injectDependencyNotes(EMPTY, CHANGES);
  assert.equal(injectDependencyNotes(once, CHANGES), once);
});

test('a package a human already wrote about is SKIPPED, not duplicated', () => {
  // The real case: 0.2.1's hand-written nodemailer entry explains the injection and STARTTLS fixes.
  // A derived "from 7.0.13 to 9.0.5" bullet would be strictly worse and would read as a second,
  // conflicting record of the same change.
  const human = EMPTY.replace(
    '## [Unreleased]\n',
    '## [Unreleased]\n\n### Security\n\n- Updated nodemailer to 9.0.5, which fixes header injection.\n'
  );
  const out = injectDependencyNotes(human, [{ name: 'nodemailer', from: '^7.0.13', to: '^9.0.5' }]);
  assert.equal(out, human, 'the human entry stands alone');
});

test('an existing Dependencies block is appended to, not duplicated', () => {
  const withBlock = injectDependencyNotes(EMPTY, CHANGES);
  const out = injectDependencyNotes(withBlock, [{ name: 'zod', from: '^3.0.0', to: '^4.0.0' }]);
  assert.equal(out.match(/### Dependencies/g).length, 1);
  assert.match(out, /better-sqlite3/);
  assert.match(out, /zod/);
});

test('already-released sections are never touched', () => {
  const out = injectDependencyNotes(EMPTY, CHANGES);
  assert.match(out, /## \[0\.2\.1\] - 2026-08-24\n\n- old\.\n/);
});

test('a changelog with no [Unreleased] header is returned unchanged', () => {
  const noHeader = '# Changelog\n\n## [0.1.0] - 2026-08-22\n';
  assert.equal(injectDependencyNotes(noHeader, CHANGES), noHeader);
});

// -------------------------------------------------------------- bump inference

const withSection = (heading, bullet = '- Something.') =>
  `# Changelog\n\n## [Unreleased]\n\n${heading}\n\n${bullet}\n\n## [0.2.1] - 2026-08-24\n`;

test('only fixes and dependencies means patch', () => {
  assert.equal(recommendBump(withSection('### Fixed')).bump, 'patch');
  assert.equal(recommendBump(withSection('### Security')).bump, 'patch');
  assert.equal(recommendBump(withSection('### Dependencies')).bump, 'patch');
});

test('a non-empty Added section means minor', () => {
  assert.equal(recommendBump(withSection('### Added')).bump, 'minor');
});

test('a breaking marker means major, by heading or by bullet', () => {
  assert.equal(recommendBump(withSection(BREAKING_HEADING)).bump, 'major');
  assert.equal(recommendBump(withSection('### Changed', '- **Breaking:** you must migrate.')).bump, 'major');
});

test('a plain Changed section alone is AMBIGUOUS and refuses to guess', () => {
  const result = recommendBump(withSection('### Changed'));
  assert.equal(result.bump, null);
  assert.equal(result.ambiguous, true);
  assert.match(result.reason, /Choose the bump explicitly/);
});

test('ambiguity does not block when something higher already decides', () => {
  // "Changed" plus "Added" is minor: the ambiguity changes no outcome, so it must not stop a release.
  const both = `# Changelog\n\n## [Unreleased]\n\n### Added\n\n- A capability.\n\n### Changed\n\n- Something.\n\n## [0.2.1] - 2026-08-24\n`;
  const result = recommendBump(both);
  assert.equal(result.bump, 'minor');
  assert.equal(result.ambiguous, false);
});

test('an EMPTY heading with no bullets does not count as a section', () => {
  const emptyAdded = `# Changelog\n\n## [Unreleased]\n\n### Added\n\n### Fixed\n\n- A fix.\n\n## [0.2.1] - 2026-08-24\n`;
  assert.equal(recommendBump(emptyAdded).bump, 'patch', 'an empty Added must not force a minor');
});

test('an empty [Unreleased] recommends nothing', () => {
  assert.equal(recommendBump(EMPTY).bump, null);
});

test('an override may raise the bump but never lower it below the minimum', () => {
  assert.equal(checkOverride('major', 'minor').ok, true);
  assert.equal(checkOverride('minor', 'minor').ok, true);
  assert.equal(checkOverride('patch', 'minor').ok, false);
  assert.match(checkOverride('patch', 'minor').error, /requires at least "minor"/);
  assert.equal(checkOverride('minor', 'major').ok, false);
});

test('with no mechanical minimum, any override is allowed', () => {
  assert.equal(checkOverride('patch', null).ok, true);
});
