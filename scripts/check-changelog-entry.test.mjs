// The changelog gate. Written after seven dependency PRs merged in one batch with no CHANGELOG
// entry between them, which nothing in CI asked for.
//
// Pure fixtures only -- no git, no GitHub payload -- matching the other release-tooling tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  checkChangelogGate,
  formatGateFailure,
  isShippingPath,
  parseUnreleasedBullets,
  SKIP_LABEL,
} from './check-changelog-entry.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const EMPTY_CHANGELOG = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '## [0.2.1] - 2026-08-24',
  '',
  '### Fixed',
  '- Something already shipped.',
  '',
].join('\n');

const WITH_ENTRY = EMPTY_CHANGELOG.replace(
  '## [Unreleased]\n',
  '## [Unreleased]\n\n### Fixed\n- A brand new thing.\n'
);

/** An ordinary contributor PR touching product code. */
const BASE_INPUT = Object.freeze({
  author: 'someone',
  headRef: 'fix/some-bug',
  headRepoFullName: 'rulebeat/rulebeat',
  repository: 'rulebeat/rulebeat',
  labels: [],
  changedPaths: ['packages/web/app/page.tsx'],
  basePackageVersion: '0.2.1',
  baseChangelog: EMPTY_CHANGELOG,
  headChangelog: EMPTY_CHANGELOG,
});

// ------------------------------------------------------------ path classification

test('unknown paths default to shipping, so a new file type fails closed', () => {
  assert.equal(isShippingPath('some/new/thing.rs'), true);
  assert.equal(isShippingPath('Cargo.toml'), true);
  assert.equal(isShippingPath('packages/web/app/page.tsx'), true);
});

test('docs, workflows, tests and the top-level brand kit are exempt', () => {
  for (const p of [
    'docs/public/install.md',
    'README.md',
    '.github/workflows/ci.yml',
    'brand/icon/mark.svg',
    'packages/web/tests/unit/x.test.ts',
    'packages/core/src/engine/kql.test.ts',
    'scripts/release-smoke-test.sh',
    'scripts/check-changelog-entry.test.mjs',
    'LICENSE',
  ]) {
    assert.equal(isShippingPath(p), false, `${p} should be exempt`);
  }
});

test('packages/web/public SHIPS even though a top-level brand/ path does not', () => {
  // Two `brand` directories exist. Only the top-level source kit is inert; the one under
  // packages/web/public is copied into the image and referenced by the sign-in and error pages.
  // Getting these the wrong way round would silently exempt every logo change in the running app.
  assert.equal(isShippingPath('packages/web/public/brand/mark.png'), true);
  assert.equal(isShippingPath('brand/icon/mark.svg'), false);
});

test('the release files and the Dockerfile ship', () => {
  for (const p of ['Dockerfile', 'package.json', 'package-lock.json', 'packages/core/package.json']) {
    assert.equal(isShippingPath(p), true, `${p} should ship`);
  }
});

// ------------------------------------------------------------------- bullet parsing

test('a bullet reflowed across different line breaks is not a new bullet', () => {
  const a = '## [Unreleased]\n\n- One sentence that happens to be\n  wrapped here.\n';
  const b = '## [Unreleased]\n\n- One sentence that happens\n  to be wrapped here.\n';
  assert.deepEqual(parseUnreleasedBullets(a), parseUnreleasedBullets(b));
});

test('intra-line whitespace differences are normalized away too', () => {
  // Distinct from the reflow case above, which folding already handles: this is the same single
  // line respaced (a double space, a tab, trailing space), which only the \s+ collapse catches.
  const a = '## [Unreleased]\n\n- Two spaces and a tab.\n';
  const b = '## [Unreleased]\n\n- Two  spaces\tand a tab.   \n';
  assert.deepEqual(parseUnreleasedBullets(a), parseUnreleasedBullets(b));
  assert.deepEqual(parseUnreleasedBullets(b), ['Two spaces and a tab.']);
});

test('parsing stops at the next release header', () => {
  const bullets = parseUnreleasedBullets(EMPTY_CHANGELOG);
  assert.deepEqual(bullets, [], 'the already-released bullet must not be counted');
});

test('parseUnreleasedBullets returns null when the header is missing', () => {
  assert.equal(parseUnreleasedBullets('# Changelog\n\n## [0.1.0] - 2026-08-22\n\n- x\n'), null);
});

// -------------------------------------------------------------------- the gate

test('a shipping change with no new entry fails', () => {
  const result = checkChangelogGate(BASE_INPUT);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-entry');
  assert.deepEqual(result.shippingPaths, ['packages/web/app/page.tsx']);
});

test('a shipping change that adds an entry passes', () => {
  const result = checkChangelogGate({ ...BASE_INPUT, headChangelog: WITH_ENTRY });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'entry-added');
});

test('editing an ALREADY-RELEASED entry does not count as adding one', () => {
  const editedOldEntry = EMPTY_CHANGELOG.replace(
    '- Something already shipped.',
    '- Something already shipped, reworded.'
  );
  const result = checkChangelogGate({ ...BASE_INPUT, headChangelog: editedOldEntry });
  assert.equal(result.ok, false, 'a released section is not where new work is recorded');
});

test('a docs-only PR is exempt without any label', () => {
  const result = checkChangelogGate({
    ...BASE_INPUT,
    changedPaths: ['docs/public/install.md', 'README.md'],
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'non-shipping');
});

test('docs PLUS product code is not exempt', () => {
  const result = checkChangelogGate({
    ...BASE_INPUT,
    changedPaths: ['docs/public/install.md', 'packages/core/src/engine/kql.ts'],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.shippingPaths, ['packages/core/src/engine/kql.ts']);
});

test('DELETING a shipping file still requires an entry', () => {
  const result = checkChangelogGate({
    ...BASE_INPUT,
    changedPaths: ['packages/web/lib/scan-runner.ts'],
  });
  assert.equal(result.ok, false);
});

test('moving a shipping file into docs/ is not exempted by the new path', () => {
  // --no-renames makes git report both sides, so the old shipping path is still classified.
  const result = checkChangelogGate({
    ...BASE_INPUT,
    changedPaths: ['packages/web/lib/scan-runner.ts', 'docs/scan-runner.ts'],
  });
  assert.equal(result.ok, false);
  assert.ok(result.shippingPaths.includes('packages/web/lib/scan-runner.ts'));
});

test('a PR that only merged base entries in, adding none of its own, FAILS', () => {
  // The reason [Unreleased] is compared against the current base rather than the merge base: the
  // bullet exists in head, but it came from main, not from this PR.
  const result = checkChangelogGate({
    ...BASE_INPUT,
    baseChangelog: WITH_ENTRY,
    headChangelog: WITH_ENTRY,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-entry');
});

test('the no-changelog label exempts, and a lookalike label does not', () => {
  assert.equal(checkChangelogGate({ ...BASE_INPUT, labels: [SKIP_LABEL] }).ok, true);
  assert.equal(checkChangelogGate({ ...BASE_INPUT, labels: ['no-changelog-really'] }).ok, false);
});

test('an empty changedPaths list fails closed', () => {
  const result = checkChangelogGate({ ...BASE_INPUT, changedPaths: [] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-changed-paths');
  assert.match(result.error, /bug in how the diff range was computed/);
});

test('a missing [Unreleased] header is reported clearly, not thrown', () => {
  const result = checkChangelogGate({
    ...BASE_INPUT,
    baseChangelog: '# Changelog\n\n## [0.2.1] - 2026-08-24\n',
    headChangelog: '# Changelog\n\n## [0.2.1] - 2026-08-24\n',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-unreleased-header');
});

// ---------------------------------------------------------- the release exemption

test('a genuine release PR is exempt, because a release EMPTIES [Unreleased]', () => {
  const result = checkChangelogGate({
    ...BASE_INPUT,
    author: 'github-actions[bot]',
    headRef: 'release/v0.2.1',
    changedPaths: ['package.json', 'packages/core/package.json', 'CHANGELOG.md'],
    baseChangelog: WITH_ENTRY,
    headChangelog: EMPTY_CHANGELOG,
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'release-pr');
});

test('a FORK branch named release/v0.2.1 is NOT exempt', () => {
  // The exemption uses the same identity predicate tag-release.yml does, so a branch name alone
  // buys nothing.
  const result = checkChangelogGate({
    ...BASE_INPUT,
    author: 'github-actions[bot]',
    headRef: 'release/v0.2.1',
    headRepoFullName: 'attacker/rulebeat',
  });
  assert.equal(result.ok, false);
});

test('a release-shaped branch from an ordinary author is NOT exempt', () => {
  const result = checkChangelogGate({ ...BASE_INPUT, headRef: 'release/v0.2.1' });
  assert.equal(result.ok, false);
});

// ------------------------------------------------------------------- the message

test('the failure message names the triggering files and how to proceed', () => {
  const msg = formatGateFailure(checkChangelogGate(BASE_INPUT));
  assert.match(msg, /packages\/web\/app\/page\.tsx/);
  assert.match(msg, /### Fixed/);
  assert.match(msg, new RegExp(SKIP_LABEL));
  assert.match(msg, /only a pushed `vX\.Y\.Z` tag moves `:latest`/);
});

test('the failure message truncates a very long file list', () => {
  const many = Array.from({ length: 25 }, (_, i) => `packages/web/lib/f${i}.ts`);
  const msg = formatGateFailure(checkChangelogGate({ ...BASE_INPUT, changedPaths: many }));
  assert.match(msg, /and 15 more/);
});

// -------------------------------------------------------------- against the real file

test("the repo's own CHANGELOG.md parses, and this very PR would satisfy the gate", () => {
  const real = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
  const bullets = parseUnreleasedBullets(real);
  assert.ok(Array.isArray(bullets), 'the real CHANGELOG must have an [Unreleased] header');

  // Dogfooding: this change edits scripts/ (a shipping path) and records entries, so the gate it
  // introduces must pass on it.
  const result = checkChangelogGate({
    ...BASE_INPUT,
    changedPaths: ['scripts/check-changelog-entry.mjs'],
    baseChangelog: real.replace(/## \[Unreleased\]\n[\s\S]*?(?=## \[)/, '## [Unreleased]\n\n'),
    headChangelog: real,
  });
  assert.equal(result.ok, true, 'this PR records its own changes');
});
