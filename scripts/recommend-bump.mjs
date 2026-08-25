#!/usr/bin/env node
// Reads the bump level off what has accumulated in CHANGELOG.md's [Unreleased] section, so
// "patch / minor / major" stops being a judgement someone makes from memory at release time.
//
// how-changes-are-made.md already defines the mapping; this just applies it mechanically:
//   a fix, no new capability                     -> patch
//   a new capability, nothing breaks             -> minor
//   something requires the user to act           -> major
//
// Derived from the section's CONTENT, not from commit subjects: PR-title enforcement was
// deliberately deferred, so Conventional Commits' "!" breaking marker is not available here. The
// breaking marker is therefore spelled out explicitly, and written down in conventions/releases.md
// so it is discoverable rather than folklore.

/** A section counts only if it actually has a bullet under it. */
const BULLET = /^\s*-\s+/;

export const BREAKING_HEADING = '### Changed (breaking)';
export const BREAKING_BULLET_PREFIX = '**Breaking:**';

/**
 * @param {string} changelogText
 * @returns {{ bump: 'patch'|'minor'|'major'|null, reason: string, ambiguous: boolean }}
 */
export function recommendBump(changelogText) {
  const lines = changelogText.split('\n');
  const start = lines.findIndex((l) => l.trim() === '## [Unreleased]');
  if (start === -1) {
    return { bump: null, reason: 'CHANGELOG.md has no "## [Unreleased]" header.', ambiguous: false };
  }
  let end = lines.findIndex((l, i) => i > start && l.trim().startsWith('## ['));
  if (end === -1) end = lines.length;

  /** @type {Map<string, string[]>} heading -> its bullets */
  const sections = new Map();
  let heading = null;
  for (const raw of lines.slice(start + 1, end)) {
    const line = raw.trim();
    if (line.startsWith('### ')) {
      heading = line;
      if (!sections.has(heading)) sections.set(heading, []);
      continue;
    }
    if (BULLET.test(raw) && heading) sections.get(heading).push(line);
  }

  const nonEmpty = [...sections.entries()].filter(([, bullets]) => bullets.length > 0);
  if (nonEmpty.length === 0) {
    return {
      bump: null,
      reason: 'CHANGELOG.md\'s "## [Unreleased]" section is empty. Nothing to release.',
      ambiguous: false,
    };
  }

  const hasBreaking = nonEmpty.some(
    ([h, bullets]) =>
      h === BREAKING_HEADING ||
      bullets.some((b) => b.replace(BULLET, '').startsWith(BREAKING_BULLET_PREFIX))
  );
  if (hasBreaking) {
    return {
      bump: 'major',
      reason: `a breaking change is marked (${BREAKING_HEADING} or a ${BREAKING_BULLET_PREFIX} bullet)`,
      ambiguous: false,
    };
  }

  const hasAdded = nonEmpty.some(([h]) => h === '### Added');
  if (hasAdded) {
    return { bump: 'minor', reason: 'a non-empty "### Added" section adds a capability', ambiguous: false };
  }

  // "Changed" alone is genuinely ambiguous: it covers both "different behaviour, harmless" and
  // "different behaviour, you will notice". It only BLOCKS when nothing higher already decided --
  // ambiguity that changes no outcome should not stop a release.
  const hasPlainChanged = nonEmpty.some(([h]) => h === '### Changed');
  if (hasPlainChanged) {
    return {
      bump: null,
      ambiguous: true,
      reason:
        'a non-empty "### Changed" section with no "### Added" and no breaking marker is ambiguous: ' +
        'it could be a patch or a minor. Choose the bump explicitly, or mark the entry breaking ' +
        `with "${BREAKING_HEADING}" or a "${BREAKING_BULLET_PREFIX}" bullet.`,
    };
  }

  return {
    bump: 'patch',
    reason: 'only fixes, security updates and dependency notes',
    ambiguous: false,
  };
}

const ORDER = { patch: 0, minor: 1, major: 2 };

/**
 * An explicit override may raise the bump but never lower it below what the changelog mechanically
 * requires. Shipping a new capability as a patch, or a breaking change as a minor, is the mistake
 * this exists to prevent.
 *
 * @param {'patch'|'minor'|'major'} requested
 * @param {'patch'|'minor'|'major'|null} minimum
 * @returns {{ ok: boolean, error?: string }}
 */
export function checkOverride(requested, minimum) {
  if (!minimum) return { ok: true };
  if (ORDER[requested] < ORDER[minimum]) {
    return {
      ok: false,
      error:
        `A "${requested}" release was requested, but CHANGELOG.md's [Unreleased] section requires ` +
        `at least "${minimum}". Raise the bump, or move the entries that require it.`,
    };
  }
  return { ok: true };
}
