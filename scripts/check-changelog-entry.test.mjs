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
  manifestChangeShips,
  isDependabotBump,
  DEPENDABOT_AUTHOR,
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

test('no scripts/ directory ships, because none is in the runtime image', () => {
  // The Dockerfile copies only .next/standalone, .next/static, packages/web/public and
  // packages/web/data/packs, and deletes packages/web/scripts from the standalone output.
  for (const p of [
    'scripts/release.mjs',
    'scripts/check-changelog-entry.mjs',
    'scripts/sync-pack.ts',
    'packages/web/scripts/seed-e2e.ts',
  ]) {
    assert.equal(isShippingPath(p), false, `${p} is not in the image`);
  }
  // But the packs it generates are committed, and those DO ship.
  assert.equal(isShippingPath('packages/web/data/packs/aprl-v2.json'), true);
});

test('docs, workflows, tests and the top-level brand kit are exempt', () => {
  for (const p of [
    'docs/public/install.md',
    'README.md',
    '.github/workflows/ci.yml',
    'brand/icon/mark.svg',
    'packages/web/tests/unit/x.test.ts',
    'packages/core/src/engine/kql.test.ts',
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

test('the Dockerfile and the manifests ship', () => {
  for (const p of ['Dockerfile', 'package.json', 'package-lock.json', 'packages/core/package.json']) {
    assert.equal(isShippingPath(p), true, `${p} should ship`);
  }
});

// -------------------------------------------------------------- manifest refinement

test('a manifest dependency bump ships -- the case this whole gate exists for', () => {
  const base = JSON.stringify({ version: '1.0.0', dependencies: { nodemailer: '^7.0.13' } });
  const head = JSON.stringify({ version: '1.0.0', dependencies: { nodemailer: '^9.0.5' } });
  assert.equal(manifestChangeShips(base, head), true);
});

test('a manifest change that only adds an npm script does NOT ship', () => {
  // Otherwise every CI or tooling PR would need a label to get past its own npm script.
  const base = JSON.stringify({ version: '1.0.0', scripts: { test: 'vitest' } });
  const head = JSON.stringify({ version: '1.0.0', scripts: { test: 'vitest', lint: 'eslint' } });
  assert.equal(manifestChangeShips(base, head), false);
});

test('a version bump in a manifest still ships', () => {
  const base = JSON.stringify({ version: '1.0.0', scripts: { a: 'x' } });
  const head = JSON.stringify({ version: '1.0.1', scripts: { a: 'x', b: 'y' } });
  assert.equal(manifestChangeShips(base, head), true);
});

test('unparseable manifest JSON counts as shipping, never waved through', () => {
  assert.equal(manifestChangeShips('{not json', '{"version":"1.0.0"}'), true);
});

test('a PR whose only shipping-looking file is a scripts-only manifest change passes', () => {
  const base = JSON.stringify({ version: '0.2.1', scripts: { test: 'vitest' } });
  const head = JSON.stringify({ version: '0.2.1', scripts: { test: 'vitest', gate: 'node --test' } });
  const result = checkChangelogGate({
    ...BASE_INPUT,
    changedPaths: ['package.json', 'scripts/check-changelog-entry.mjs', '.github/workflows/ci.yml'],
    manifests: { 'package.json': { base, head } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'non-shipping');
});

test('without manifest contents the conservative answer is kept', () => {
  const result = checkChangelogGate({ ...BASE_INPUT, changedPaths: ['package.json'] });
  assert.equal(result.ok, false, 'no content supplied means no refinement is possible');
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

// ------------------------------------------------------------ dependency bumps

/** Exactly what Dependabot touches when it bumps one package. */
const DEPENDABOT_INPUT = Object.freeze({
  ...BASE_INPUT,
  author: DEPENDABOT_AUTHOR,
  headRef: 'dependabot/npm_and_yarn/eslint-10.9.0',
  labels: ['dependencies'],
  changedPaths: ['package.json', 'package-lock.json'],
});

test('a pure Dependabot bump is exempt: the release derives the note from the manifests', () => {
  const result = checkChangelogGate(DEPENDABOT_INPUT);
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'dependabot-bump');
});

test('a workspace manifest plus the lockfile is still a pure bump', () => {
  assert.equal(
    isDependabotBump({
      ...DEPENDABOT_INPUT,
      changedPaths: ['packages/core/package.json', 'packages/web/package.json', 'package-lock.json'],
    }),
    true
  );
});

test('a Dependabot branch carrying SOURCE changes is NOT exempt', () => {
  // The real case: @azure/arm-resourcegraph 5.0.0 moved its `timeout` option, so the bump needed
  // an edit to resource-graph.ts. That edit changes behaviour and has to be recorded.
  const result = checkChangelogGate({
    ...DEPENDABOT_INPUT,
    changedPaths: ['package.json', 'package-lock.json', 'packages/core/src/clients/resource-graph.ts'],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-entry');
  // Once the exemption declines to fire, the manifests and lockfile are shipping paths in their
  // own right again, exactly as they are for any other author.
  assert.deepEqual(result.shippingPaths, [
    'package.json',
    'package-lock.json',
    'packages/core/src/clients/resource-graph.ts',
  ]);
});

test('a human pushing to a dependabot/ branch is NOT exempt', () => {
  assert.equal(isDependabotBump({ ...DEPENDABOT_INPUT, author: 'someone' }), false);
});

test('a FORK cannot claim Dependabot identity', () => {
  assert.equal(
    isDependabotBump({ ...DEPENDABOT_INPUT, headRepoFullName: 'attacker/rulebeat' }),
    false
  );
});

test('Dependabot on a branch that is not a dependabot/ branch is NOT exempt', () => {
  assert.equal(isDependabotBump({ ...DEPENDABOT_INPUT, headRef: 'feature/sneaky' }), false);
});

test('the dependency exemption never fires on an empty path list', () => {
  assert.equal(isDependabotBump({ ...DEPENDABOT_INPUT, changedPaths: [] }), false);
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

test("the repo's own CHANGELOG.md parses, even when nothing is pending", () => {
  const real = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
  const bullets = parseUnreleasedBullets(real);
  assert.ok(Array.isArray(bullets), 'the real CHANGELOG must have an [Unreleased] header');
});

test('this very PR passes the gate, and passes it as NON-SHIPPING', () => {
  // Dogfooding, and the reason matters as much as the result. Everything this change touches --
  // CI config, docs, and scripts/ -- is outside the runtime image, so it correctly needs no
  // CHANGELOG entry at all. If a future edit here made it report `missing-entry` instead, that
  // would mean the classification had drifted back to treating tooling as product.
  const real = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
  const manifestBefore = JSON.stringify({ version: '0.2.1', scripts: { test: 'vitest' } });
  const manifestAfter = JSON.stringify({
    version: '0.2.1',
    scripts: { test: 'vitest', 'test:changelog-gate': 'node --test' },
  });

  const result = checkChangelogGate({
    ...BASE_INPUT,
    changedPaths: [
      'scripts/check-changelog-entry.mjs',
      'scripts/check-changelog-entry.test.mjs',
      '.github/workflows/pr-checks.yml',
      '.github/pull_request_template.md',
      'CONTRIBUTING.md',
      'CLAUDE.md',
      'docs/engineering/conventions/releases.md',
      'package.json',
    ],
    manifests: { 'package.json': { base: manifestBefore, head: manifestAfter } },
    baseChangelog: real,
    headChangelog: real,
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'non-shipping');
});
