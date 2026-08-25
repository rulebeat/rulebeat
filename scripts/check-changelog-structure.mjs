#!/usr/bin/env node
// Checks that CHANGELOG.md is internally consistent: that its version headers, their dates, and the
// reference-link definitions at the bottom of the file all agree with each other.
//
// Written after the footer drifted silently for a whole release cycle. bumpChangelog() moved the
// "## [X.Y.Z]" headers on every release but never touched the "[Unreleased]: .../compare/..."
// definitions below them, and those definitions are what make the heading at the TOP of the
// rendered page a real link. After 0.2.0 shipped, [Unreleased] still pointed at v0.1.0 -- silently
// presenting the whole 0.2.0 diff as unreleased -- and 0.2.0 had no link of its own at all. Nobody
// noticed until somebody clicked it. updateChangelogFooterLinks() fixed the cause; this is the test
// that keeps the class of bug from coming back in some other half-maintained field.
//
// Deliberately a separate module from verify-release-version.mjs: "is this file self-consistent" is
// a different question from "does this tag match this repo", and it needs its own fixtures. It is
// called from that script's main() rather than from inside checkReleaseVersion(), because main()
// already runs in BOTH tag-release.yml and publish-image.yml -- so these invariants gate tagging and
// promotion with no workflow changes, while that pure function's contract stays untouched.

const REPO_URL = 'https://github.com/rulebeat/rulebeat';

const VERSION_HEADER = /^## \[(\d+\.\d+\.\d+)\](?:\s+-\s+(.*))?$/;
// Catches "## [0.2]", "## [v1.0.0]", "## [1.0.0-beta]" -- shapes that look like a release header but
// would be skipped silently by the stricter pattern above, taking their entry with them.
const HEADER_LIKE = /^## \[[^\]]*\]/;
const FOOTER_LINK = /^\[([^\]]+)\]:\s*(\S+)\s*$/;

/** True for a real calendar date in YYYY-MM-DD, so 2026-02-30 is rejected rather than parsed. */
function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Descending semver comparison helper: positive when a is newer than b. */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/**
 * @param {string} changelogText
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function checkChangelogStructure(changelogText) {
  const errors = [];
  const lines = changelogText.split('\n');

  const unreleasedCount = lines.filter((l) => l.trim() === '## [Unreleased]').length;
  if (unreleasedCount === 0) {
    errors.push('CHANGELOG.md has no "## [Unreleased]" header.');
  } else if (unreleasedCount > 1) {
    errors.push(`CHANGELOG.md has ${unreleasedCount} "## [Unreleased]" headers; there must be one.`);
  }

  /** @type {{ version: string, date: string }[]} */
  const releases = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '## [Unreleased]') continue;

    const match = VERSION_HEADER.exec(line);
    if (match) {
      const [, version, date] = match;
      if (date === undefined) {
        errors.push(`Release header "## [${version}]" has no date.`);
      } else if (!isRealDate(date.trim())) {
        errors.push(
          `Release header "## [${version}]" has date "${date.trim()}", which is not a real ` +
            'YYYY-MM-DD calendar date.'
        );
      }
      releases.push({ version, date: (date ?? '').trim() });
      continue;
    }

    // Shaped like a release header but not one. Reported rather than skipped: a silent skip is how
    // a whole release entry goes missing from the checks below.
    if (HEADER_LIKE.test(line)) {
      errors.push(`"${line}" looks like a release header but does not match "## [X.Y.Z] - date".`);
    }
  }

  const seenVersions = new Set();
  for (const { version } of releases) {
    if (seenVersions.has(version)) errors.push(`Duplicate release header for ${version}.`);
    seenVersions.add(version);
  }

  for (let i = 1; i < releases.length; i += 1) {
    const prev = releases[i - 1];
    const curr = releases[i];
    if (compareVersions(prev.version, curr.version) <= 0) {
      errors.push(
        `Release headers must run newest first: ${prev.version} appears above ${curr.version}.`
      );
    }
    if (prev.date && curr.date && isRealDate(prev.date) && isRealDate(curr.date) && prev.date < curr.date) {
      errors.push(
        `Release dates must not increase down the file: ${prev.version} (${prev.date}) appears ` +
          `above ${curr.version} (${curr.date}).`
      );
    }
  }

  /** @type {Map<string, string[]>} label -> targets, so duplicates are visible */
  const footer = new Map();
  for (const raw of lines) {
    const match = FOOTER_LINK.exec(raw.trim());
    if (!match) continue;
    const [, label, target] = match;
    footer.set(label, [...(footer.get(label) ?? []), target]);
  }

  for (const [label, targets] of footer) {
    if (targets.length > 1) {
      errors.push(`Footer link [${label}] is defined ${targets.length} times.`);
    }
  }

  const newest = releases[0]?.version;

  if (unreleasedCount > 0) {
    const targets = footer.get('Unreleased');
    if (!targets) {
      errors.push('There is no "[Unreleased]:" footer link, so the heading renders as broken text.');
    } else if (newest) {
      const expected = `${REPO_URL}/compare/v${newest}...HEAD`;
      if (targets[0] !== expected) {
        // The original bug, in one line.
        errors.push(
          `[Unreleased] points at "${targets[0]}" but the newest release is ${newest}; ` +
            `it must be "${expected}".`
        );
      }
    }
  }

  for (let i = 0; i < releases.length; i += 1) {
    const { version } = releases[i];
    const targets = footer.get(version);
    if (!targets) {
      errors.push(`Release ${version} has a header but no "[${version}]:" footer link.`);
      continue;
    }
    const older = releases[i + 1]?.version;
    const expected = older
      ? `${REPO_URL}/compare/v${older}...v${version}`
      : `${REPO_URL}/releases/tag/v${version}`;
    if (targets[0] !== expected) {
      errors.push(`[${version}] points at "${targets[0]}"; it must be "${expected}".`);
    }
  }

  for (const label of footer.keys()) {
    if (label === 'Unreleased') continue;
    if (!seenVersions.has(label)) {
      errors.push(`Footer link [${label}] has no matching "## [${label}]" header.`);
    }
  }

  return { ok: errors.length === 0, errors };
}
