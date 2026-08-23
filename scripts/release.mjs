#!/usr/bin/env node
// Cuts a release: bumps root/core/web package.json to the same new version, resyncs
// package-lock.json against them, moves CHANGELOG.md's [Unreleased] content under a new dated
// header, then commits all five files together and tags the commit. The four places that have to
// agree about "what version is this" get written by one command at one instant, instead of by
// hand, one file at a time -- which is exactly the drift scripts/verify-release-version.mjs
// exists to catch if this script is ever bypassed. Never pushes; that stays a separate, deliberate
// step, same as every other release action in this repo.
//
// Usage: npm run release -- <patch|minor|major>

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Overridable so the smoke test can point this at a scratch fixture repo instead of the real one,
// the same env-var-override idiom packages/web/tests/setup.ts already uses for RULEBEAT_DB_PATH.
const root = process.env.RELEASE_SCRIPT_ROOT
  ? resolve(process.env.RELEASE_SCRIPT_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ROOT_PKG = resolve(root, 'package.json');
const CORE_PKG = resolve(root, 'packages/core/package.json');
const WEB_PKG = resolve(root, 'packages/web/package.json');
const CHANGELOG = resolve(root, 'CHANGELOG.md');

const VALID_BUMPS = new Set(['patch', 'minor', 'major']);

/**
 * Moves CHANGELOG.md's "## [Unreleased]" content under a new dated version header, leaving a
 * fresh empty "## [Unreleased]" behind. Pure and side-effect-free so it is directly testable
 * against fixtures, including the repo's own real CHANGELOG content.
 *
 * A section counts as non-empty if it contains any bullet line anywhere in its range, regardless
 * of which "###" subheading (if any) it sits under; those subheadings are preserved verbatim,
 * never re-parsed.
 *
 * @param {string} changelogText
 * @param {string} version e.g. "0.1.1"
 * @param {string} dateStr e.g. "2026-09-01"
 * @returns {string} the rewritten CHANGELOG.md content
 */
export function bumpChangelog(changelogText, version, dateStr) {
  const lines = changelogText.split('\n');

  const unreleasedIdx = lines.findIndex((l) => l.trim() === '## [Unreleased]');
  if (unreleasedIdx === -1) {
    throw new Error('CHANGELOG.md has no "## [Unreleased]" header.');
  }

  const alreadyReleased = lines.some((l) => l.trim().startsWith(`## [${version}]`));
  if (alreadyReleased) {
    throw new Error(`CHANGELOG.md already has a "## [${version}]" header. Already released?`);
  }

  let nextHeaderIdx = lines.findIndex((l, i) => i > unreleasedIdx && l.trim().startsWith('## ['));
  if (nextHeaderIdx === -1) nextHeaderIdx = lines.length;

  const sectionLines = lines.slice(unreleasedIdx + 1, nextHeaderIdx);
  const hasContent = sectionLines.some((l) => /^\s*-\s+/.test(l));
  if (!hasContent) {
    throw new Error('CHANGELOG.md\'s "## [Unreleased]" section is empty. Nothing to release.');
  }

  const start = sectionLines[0] === '' ? 1 : 0;
  const end = sectionLines[sectionLines.length - 1] === '' ? sectionLines.length - 1 : sectionLines.length;
  const trimmedSection = sectionLines.slice(start, end);

  const before = lines.slice(0, unreleasedIdx + 1);
  const after = lines.slice(nextHeaderIdx);
  const newSection = ['', `## [${version}] - ${dateStr}`, '', ...trimmedSection, ''];

  return [...before, ...newSection, ...after].join('\n');
}

function readVersion(pkgPath) {
  return JSON.parse(readFileSync(pkgPath, 'utf8')).version;
}

function writeVersion(pkgPath, version) {
  const text = readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(text);
  pkg.version = version;
  const trailingNewline = text.endsWith('\n') ? '\n' : '';
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + trailingNewline);
}

function isWorkingTreeClean() {
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  return status.trim() === '';
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function main() {
  const bump = process.argv[2];
  if (!VALID_BUMPS.has(bump)) {
    console.error('Usage: npm run release -- <patch|minor|major>');
    process.exit(2);
  }

  if (!isWorkingTreeClean()) {
    console.error(
      'Working tree is not clean. The release commit must contain only the version bump -- ' +
        'commit or stash everything else first.'
    );
    process.exit(1);
  }

  // Compute the new version once, via npm's own bump arithmetic, from the root package.json --
  // then write that identical string into the other two directly, rather than bumping each of the
  // three independently, so nothing can make them disagree with each other. (They are only ever
  // this consistent to bump from in the first place because verify-release-version.mjs already
  // refuses to let a previous release ship with them disagreeing.)
  execFileSync('npm', ['version', bump, '--no-git-tag-version'], { cwd: root, stdio: 'inherit' });
  const version = readVersion(ROOT_PKG);

  writeVersion(CORE_PKG, version);
  writeVersion(WEB_PKG, version);

  execFileSync('npm', ['install', '--package-lock-only'], { cwd: root, stdio: 'inherit' });

  const changelogText = readFileSync(CHANGELOG, 'utf8');
  const newChangelog = bumpChangelog(changelogText, version, todayISO());
  writeFileSync(CHANGELOG, newChangelog);

  execFileSync(
    'git',
    [
      'add',
      'package.json',
      'package-lock.json',
      'packages/core/package.json',
      'packages/web/package.json',
      'CHANGELOG.md',
    ],
    { cwd: root, stdio: 'inherit' }
  );
  execFileSync('git', ['commit', '-m', `release: v${version}`], { cwd: root, stdio: 'inherit' });
  execFileSync('git', ['tag', '-a', `v${version}`, '-m', `v${version}`], { cwd: root, stdio: 'inherit' });

  console.log(`\nCreated commit and annotated tag v${version}. Nothing pushed yet.`);
  console.log('Review with: git show HEAD');
  console.log(`Push with:   git push && git push origin v${version}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
