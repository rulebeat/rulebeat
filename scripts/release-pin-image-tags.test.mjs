// pinImageTags rewrites every image reference in the public docs to the new release's tag,
// inside the same release commit that bumps package.json. The failure it exists to prevent is
// concrete: 0.1.0 survived the 0.2.0 release in nine doc places, which pushed the docs to
// `:latest` for 0.2.4; pinning is back because this rewrite makes a stale pin impossible, and
// packages/web/tests/unit/docs-numbers-drift.test.ts fails the build if a doc ever disagrees
// with package.json anyway. Pure-function tests here, mirroring release-bump-changelog.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinImageTags } from './release.mjs';

test('rewrites :latest to the new version tag', () => {
  const before = 'docker run ghcr.io/rulebeat/rulebeat:latest';
  assert.equal(pinImageTags(before, '0.2.5'), 'docker run ghcr.io/rulebeat/rulebeat:0.2.5');
});

test('rewrites a stale pinned tag to the new version tag', () => {
  const before = 'image: ghcr.io/rulebeat/rulebeat:0.2.4';
  assert.equal(pinImageTags(before, '0.3.0'), 'image: ghcr.io/rulebeat/rulebeat:0.3.0');
});

test('rewrites every reference in a doc, mixed floating and pinned', () => {
  const before = [
    'ghcr.io/rulebeat/rulebeat:latest',
    'ghcr.io/rulebeat/rulebeat:0.1.0',
    'ghcr.io/rulebeat/rulebeat:0.2.4',
  ].join('\n');
  const after = pinImageTags(before, '0.2.5');
  assert.equal(after.match(/ghcr\.io\/rulebeat\/rulebeat:0\.2\.5/g).length, 3);
  assert.ok(!after.includes(':latest'));
});

test('leaves sha- image refs and bare image mentions alone', () => {
  const before = [
    'the CI build is ghcr.io/rulebeat/rulebeat:sha-abc1234',
    'images published to `ghcr.io/rulebeat/rulebeat` are signed',
  ].join('\n');
  assert.equal(pinImageTags(before, '0.2.5'), before);
});

test('image tags never carry a v prefix', () => {
  // publish-image.yml derives the tag as ${GITHUB_REF_NAME#v}, so :v0.2.5 does not exist as an
  // image tag; a doc pinned to it would fail for everyone who copies the command.
  const after = pinImageTags('ghcr.io/rulebeat/rulebeat:latest', '0.2.5');
  assert.ok(!after.includes(':v0.2.5'));
  assert.ok(after.includes(':0.2.5'));
});
