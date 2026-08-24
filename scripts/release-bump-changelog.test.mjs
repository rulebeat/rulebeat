// bumpChangelog is the riskiest part of scripts/release.mjs (per spec 045's challenge: mutating a
// real, hand-curated, nested-markdown file is harder to get right than the well-trodden
// version-bump-and-tag mechanics) so it gets pure, isolated tests here, separate from the
// end-to-end scripts/release-smoke-test.sh -- including a fixture built from this repo's own real
// CHANGELOG.md shape, not only a synthetic simplification of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { bumpChangelog, updateChangelogFooterLinks } from './release.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('moves [Unreleased] content under a new dated header, leaves a fresh empty [Unreleased]', () => {
  const before = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '### Added',
    '- Something new.',
    '',
    '## [0.1.0] - 2026-08-22',
    '',
    'First public release.',
    '',
  ].join('\n');

  const after = bumpChangelog(before, '0.1.1', '2026-09-01');
  const lines = after.split('\n');

  assert.equal(lines[lines.indexOf('## [Unreleased]') + 1], '');
  assert.equal(lines[lines.indexOf('## [Unreleased]') + 2], '## [0.1.1] - 2026-09-01');
  assert.ok(after.includes('### Added\n- Something new.'));
  assert.ok(after.indexOf('## [0.1.1]') < after.indexOf('## [0.1.0]'), 'newest release stays first');
});

test('refuses when [Unreleased] has no bullet content, changes nothing', () => {
  const before = '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-08-22\n\nFirst release.\n';
  assert.throws(() => bumpChangelog(before, '0.1.1', '2026-09-01'), /empty/i);
});

test('refuses when the target version already has a header', () => {
  const before =
    '# Changelog\n\n## [Unreleased]\n\n- New thing.\n\n## [0.1.1] - 2026-08-30\n\nAlready shipped.\n';
  assert.throws(() => bumpChangelog(before, '0.1.1', '2026-09-01'), /already has/i);
});

test('refuses when there is no [Unreleased] header at all', () => {
  const before = '# Changelog\n\n## [0.1.0] - 2026-08-22\n\nFirst release.\n';
  assert.throws(() => bumpChangelog(before, '0.1.1', '2026-09-01'), /no "## \[Unreleased\]"/);
});

test('a bullet counts regardless of which ### subheading it sits under', () => {
  const before = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '### Fixed',
    '- A bug, no ### Added section at all this time.',
    '',
    '## [0.1.0] - 2026-08-22',
    '',
  ].join('\n');

  const after = bumpChangelog(before, '0.1.1', '2026-09-01');
  assert.ok(after.includes('### Fixed\n- A bug, no ### Added section at all this time.'));
});

test('works against this repo\'s own real, current CHANGELOG.md content, not only a synthetic fixture', () => {
  const real = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
  // Simulate the state this repo will actually be in for its next release: something real under
  // [Unreleased], ahead of the already-shipped [0.1.0] entry that's really in the file today.
  const withPendingWork = real.replace(
    '## [Unreleased]\n',
    '## [Unreleased]\n\n### Fixed\n- A real fix, shaped like this repo\'s own CHANGELOG entries.\n'
  );

  const after = bumpChangelog(withPendingWork, '0.1.1', '2026-09-01');

  assert.ok(after.includes('## [0.1.1] - 2026-09-01'));
  assert.ok(after.includes('A real fix, shaped like this repo\'s own CHANGELOG entries.'));
  assert.ok(after.includes('## [0.1.0]'), 'the real prior release entry must survive untouched');
  assert.ok(
    after.indexOf('## [0.1.1]') < after.indexOf('## [0.1.0]'),
    'the new release must sort above the real 0.1.0 entry'
  );
});

// updateChangelogFooterLinks: the reference-link definitions at the bottom of the file are what
// make the "## [Unreleased]" heading at the *top* of the rendered page a real clickable link.
// bumpChangelog only ever moves headers/content; it was never taught to keep this footer in sync,
// which is exactly how the real CHANGELOG.md drifted -- [Unreleased] still points at
// compare/v0.1.0...HEAD after 0.2.0 shipped, silently including the whole 0.2.0 diff as
// "unreleased" and giving 0.2.0 no link of its own.

test('repoints [Unreleased] at the new version and inserts a compare link for it', () => {
  const before = [
    '## [Unreleased]',
    '',
    '## [0.1.0] - 2026-08-22',
    '',
    '[Unreleased]: https://github.com/rulebeat/rulebeat/compare/v0.1.0...HEAD',
    '[0.1.0]: https://github.com/rulebeat/rulebeat/releases/tag/v0.1.0',
    '',
  ].join('\n');

  const after = updateChangelogFooterLinks(before, '0.1.0', '0.1.1');
  const lines = after.split('\n');

  assert.ok(
    lines.includes('[Unreleased]: https://github.com/rulebeat/rulebeat/compare/v0.1.1...HEAD'),
    '[Unreleased] must repoint at the version that was just released, not the old one'
  );
  assert.ok(
    lines.includes('[0.1.1]: https://github.com/rulebeat/rulebeat/compare/v0.1.0...v0.1.1'),
    'the newly released version needs its own compare link, against the version before it'
  );
  assert.ok(
    lines.includes('[0.1.0]: https://github.com/rulebeat/rulebeat/releases/tag/v0.1.0'),
    'an older release link is untouched, not rewritten'
  );
  assert.ok(
    after.indexOf('[0.1.1]:') < after.indexOf('[0.1.0]:'),
    'newest release link stays first, same order as the headers above it'
  );
});

test('appends both links when the file has no [Unreleased] footer link at all yet', () => {
  const before = '## [Unreleased]\n\n- Something.\n\n## [0.1.0] - 2026-08-22\n';

  const after = updateChangelogFooterLinks(before, '0.1.0', '0.1.1');

  assert.ok(after.includes('[Unreleased]: https://github.com/rulebeat/rulebeat/compare/v0.1.1...HEAD'));
  assert.ok(after.includes('[0.1.1]: https://github.com/rulebeat/rulebeat/compare/v0.1.0...v0.1.1'));
});

test('walks this repo\'s own real footer forward correctly, leaving older links untouched', () => {
  const real = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');

  const after = updateChangelogFooterLinks(real, '0.2.0', '0.2.1');

  assert.ok(after.includes('[Unreleased]: https://github.com/rulebeat/rulebeat/compare/v0.2.1...HEAD'));
  assert.ok(after.includes('[0.2.1]: https://github.com/rulebeat/rulebeat/compare/v0.2.0...v0.2.1'));
  assert.ok(
    after.includes('[0.1.0]: https://github.com/rulebeat/rulebeat/releases/tag/v0.1.0'),
    'the real 0.1.0 link must survive untouched'
  );
});
