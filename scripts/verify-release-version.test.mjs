// Node's built-in test runner, not vitest: this script lives outside both vitest projects
// (packages/core, packages/web) and is release tooling rather than product code, matching the
// existing pattern for scripts/docker-smoke-test.sh (verified by running it directly).
//
// Run: node --test scripts/verify-release-version.test.mjs   (also: npm run test:release-version)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkReleaseVersion } from './verify-release-version.mjs';

const matchingPackages = {
  'package.json': '0.1.0',
  'packages/core/package.json': '0.1.0',
  'packages/web/package.json': '0.1.0',
};

const changelogRealDate =
  '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-08-22\n\nFirst public release.\n';
const changelogTBD = '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - TBD\n\nFirst public release.\n';

test('exact match across package.json and a real CHANGELOG date passes', () => {
  const result = checkReleaseVersion({
    version: '0.1.0',
    packageVersions: matchingPackages,
    changelogText: changelogRealDate,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('a single mismatched package.json version fails, naming the file', () => {
  const result = checkReleaseVersion({
    version: '0.1.0',
    packageVersions: { ...matchingPackages, 'packages/web/package.json': '0.1.1' },
    changelogText: changelogRealDate,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('packages/web/package.json')));
});

test('a TBD CHANGELOG date fails even when every package.json matches', () => {
  const result = checkReleaseVersion({
    version: '0.1.0',
    packageVersions: matchingPackages,
    changelogText: changelogTBD,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('not a real date')));
});

test('a CHANGELOG with no header at all for the version fails', () => {
  const result = checkReleaseVersion({
    version: '0.2.0',
    packageVersions: {
      'package.json': '0.2.0',
      'packages/core/package.json': '0.2.0',
      'packages/web/package.json': '0.2.0',
    },
    changelogText: changelogRealDate,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('no "## [0.2.0]" header')));
});

test('two independently mismatched package.json files are both reported, not just the first', () => {
  const result = checkReleaseVersion({
    version: '0.1.0',
    packageVersions: {
      ...matchingPackages,
      'packages/core/package.json': '0.0.9',
      'packages/web/package.json': '0.1.1',
    },
    changelogText: changelogRealDate,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('packages/core/package.json')));
  assert.ok(result.errors.some((e) => e.includes('packages/web/package.json')));
});
