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
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, relative, resolve } from 'node:path';
import { diffRuntimeDependencies, injectDependencyNotes, RUNTIME_MANIFESTS } from './release-dependency-notes.mjs';
import { recommendBump, checkOverride } from './recommend-bump.mjs';

// Overridable so the smoke test can point this at a scratch fixture repo instead of the real one,
// the same env-var-override idiom packages/web/tests/setup.ts already uses for RULEBEAT_DB_PATH.
const root = process.env.RELEASE_SCRIPT_ROOT
  ? resolve(process.env.RELEASE_SCRIPT_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ROOT_PKG = resolve(root, 'package.json');
const CORE_PKG = resolve(root, 'packages/core/package.json');
const WEB_PKG = resolve(root, 'packages/web/package.json');
const CHANGELOG = resolve(root, 'CHANGELOG.md');
const LOCKFILE = resolve(root, 'package-lock.json');
const README = resolve(root, 'README.md');
const PUBLIC_DOCS_DIR = resolve(root, 'docs/public');

const VALID_BUMPS = new Set(['patch', 'minor', 'major', 'auto']);
const REPO_URL = 'https://github.com/rulebeat/rulebeat';

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

/**
 * Keeps the reference-link definitions at the bottom of CHANGELOG.md in sync with the version
 * headers bumpChangelog() just rewrote above them. Those definitions are what make the
 * "## [Unreleased]" heading at the *top* of the rendered page a real link -- bumpChangelog only
 * ever touches headers/content, never this footer, so left alone it drifts: [Unreleased] keeps
 * pointing at whatever version was newest the last time a human happened to update it by hand, and
 * the version that just shipped gets no link of its own.
 *
 * Pure and side-effect-free, same as bumpChangelog, and meant to run right after it.
 *
 * @param {string} changelogText
 * @param {string} previousVersion e.g. "0.1.0" -- the version being superseded
 * @param {string} newVersion e.g. "0.1.1" -- the version that was just released
 * @returns {string} the rewritten CHANGELOG.md content
 */
export function updateChangelogFooterLinks(changelogText, previousVersion, newVersion) {
  const lines = changelogText.split('\n');
  const newUnreleasedLine = `[Unreleased]: ${REPO_URL}/compare/v${newVersion}...HEAD`;
  const newVersionLine = `[${newVersion}]: ${REPO_URL}/compare/v${previousVersion}...v${newVersion}`;

  const unreleasedLinkIdx = lines.findIndex((l) => l.startsWith('[Unreleased]:'));
  if (unreleasedLinkIdx === -1) {
    const withTrailingNewline = changelogText.endsWith('\n') ? changelogText : `${changelogText}\n`;
    return `${withTrailingNewline}${newUnreleasedLine}\n${newVersionLine}\n`;
  }

  lines[unreleasedLinkIdx] = newUnreleasedLine;
  lines.splice(unreleasedLinkIdx + 1, 0, newVersionLine);
  return lines.join('\n');
}

/**
 * Rewrites every pinned or floating image reference in a doc to the new release's image tag.
 * The docs pin the exact version on purpose (a copied install command is reproducible, and the
 * page always names the newest release); this rewrite, running inside the same release commit
 * that bumps package.json, is what keeps a pin from ever going stale, the failure that pushed
 * the docs to `:latest` for 0.2.4. Image tags carry no `v` prefix: publish-image.yml derives
 * them as `${GITHUB_REF_NAME#v}`. `sha-<commit>` refs and bare `ghcr.io/rulebeat/rulebeat`
 * prose mentions are deliberately not matched.
 *
 * The drift test (packages/web/tests/unit/docs-numbers-drift.test.ts) is the other half of the
 * contract: it fails whenever a doc references `:latest` or a version other than package.json's.
 *
 * @param {string} text a doc's full content
 * @param {string} version the new version, no `v` prefix (e.g. "0.2.5")
 * @returns {string} the rewritten content
 */
export function pinImageTags(text, version) {
  return text.replace(/ghcr\.io\/rulebeat\/rulebeat:(?:latest|\d+\.\d+\.\d+)/g, `ghcr.io/rulebeat/rulebeat:${version}`);
}

/**
 * README.md plus every docs/public/*.md, the files pinImageTags rewrites at release time. Both
 * are optional: the release smoke test runs this script against minimal fixture repos that carry
 * neither, and a missing doc is simply not a rewrite target, not an error.
 */
export function imageRefDocPaths() {
  const paths = [];
  if (existsSync(README)) paths.push(README);
  if (existsSync(PUBLIC_DOCS_DIR)) {
    paths.push(
      ...readdirSync(PUBLIC_DOCS_DIR)
        .filter((f) => f.endsWith('.md'))
        .map((f) => resolve(PUBLIC_DOCS_DIR, f))
    );
  }
  return paths;
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

/**
 * Reads every given file, and returns a function that writes them all back byte-for-byte. Used to
 * make the mutating half of a release all-or-nothing: `npm version` and `npm install` both mutate
 * before anything has validated the changelog, and `npm install` can itself fail partway.
 *
 * A file that does not exist yet is recorded as absent and removed again on restore, so a first
 * run that creates package-lock.json does not leave one behind when it aborts.
 *
 * @param {string[]} paths
 * @returns {() => void}
 */
function snapshot(paths) {
  const saved = paths.map((path) => ({
    path,
    existed: existsSync(path),
    content: existsSync(path) ? readFileSync(path) : null,
  }));
  return () => {
    for (const { path, existed, content } of saved) {
      if (existed) writeFileSync(path, content);
      else if (existsSync(path)) rmSync(path);
    }
  };
}

/**
 * The two runtime manifests as they were at the previous release tag.
 *
 * Fails closed. The previous version is known exactly (it is in package.json), so "that tag is not
 * reachable" is a real fault -- a shallow clone, or a tag that was never pushed -- not a reason to
 * silently fall back to scanning all history and emitting a twenty-bullet Dependencies block.
 *
 * @param {string} previousVersion
 * @returns {Record<string,string>}
 */
function manifestsAtPreviousRelease(previousVersion) {
  const tag = `v${previousVersion}`;
  try {
    execFileSync('git', ['rev-parse', '--verify', `${tag}^{commit}`], { cwd: root, stdio: 'ignore' });
  } catch {
    // Two very different situations, and collapsing them would be wrong in both directions.
    const anyTags = execFileSync('git', ['tag', '--list', 'v*'], { cwd: root, encoding: 'utf8' }).trim();
    if (!anyTags) {
      // Nothing has ever been released here, so there is no previous state to diff against. That
      // is not a fault, and refusing would make a project's first release impossible.
      return null;
    }
    // Tags exist but this specific one does not: a shallow clone, or a tag that was never pushed.
    // Guessing here is how a release grows a twenty-bullet Dependencies block from all of history.
    throw new Error(
      `Cannot read the previous release: tag ${tag} is not reachable here, though other version ` +
        'tags are. Fetch tags (actions/checkout with fetch-depth: 0 fetches them) and try again. ' +
        'Refusing to guess at the dependency notes.'
    );
  }
  const texts = {};
  for (const path of RUNTIME_MANIFESTS) {
    try {
      texts[path] = execFileSync('git', ['show', `${tag}:${path}`], { cwd: root, encoding: 'utf8' });
    } catch {
      texts[path] = '';
    }
  }
  return texts;
}

function isWorkingTreeClean() {
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  return status.trim() === '';
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function main() {
  const requested = process.argv[2];
  if (!VALID_BUMPS.has(requested)) {
    console.error('Usage: npm run release -- <patch|minor|major|auto>');
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
  const previousVersion = readVersion(ROOT_PKG);

  // Dependency notes come from repository state, and land BEFORE the bump so they end up inside
  // the released section rather than in the fresh [Unreleased] left behind.
  let changelogForBump = readFileSync(CHANGELOG, 'utf8');
  try {
    const baseManifests = manifestsAtPreviousRelease(previousVersion);
    if (baseManifests === null) {
      console.log('No previous release tag in this repository; skipping derived dependency notes.');
    } else {
      const depChanges = diffRuntimeDependencies(
        baseManifests,
        Object.fromEntries(RUNTIME_MANIFESTS.map((p) => [p, readFileSync(resolve(root, p), 'utf8')]))
      );
      changelogForBump = injectDependencyNotes(changelogForBump, depChanges);
      if (changelogForBump !== readFileSync(CHANGELOG, 'utf8')) {
        console.log(`Derived ${depChanges.length} dependency note(s) from the manifests.`);
      }
    }
  } catch (err) {
    console.error(`\n${err.message}`);
    process.exit(1);
  }

  // The bump is read off what accumulated in [Unreleased], including the notes just injected.
  const recommendation = recommendBump(changelogForBump);
  let bump = requested;
  if (requested === 'auto') {
    if (!recommendation.bump) {
      console.error(`\nCannot choose a bump automatically: ${recommendation.reason}`);
      process.exit(1);
    }
    bump = recommendation.bump;
    console.log(`Bump: ${bump} (${recommendation.reason}).`);
  } else {
    const override = checkOverride(requested, recommendation.ambiguous ? null : recommendation.bump);
    if (!override.ok) {
      console.error(`\n${override.error}`);
      process.exit(1);
    }
  }

  // Everything below can fail -- `npm version` and `npm install` both shell out, and
  // bumpChangelog() refuses an empty [Unreleased]. This script's contract, and what
  // how-changes-are-made.md promises, is that a refusal changes NOTHING. It used to mutate all
  // three manifests and the lockfile before ever reading the changelog, so an empty [Unreleased]
  // left a half-bumped tree behind. The snapshot is taken first and restored on any failure, which
  // keeps that promise without reimplementing npm's semver arithmetic here.
  const restore = snapshot([ROOT_PKG, CORE_PKG, WEB_PKG, LOCKFILE, CHANGELOG, ...imageRefDocPaths()]);
  let version;
  try {
    execFileSync('npm', ['version', bump, '--no-git-tag-version'], { cwd: root, stdio: 'inherit' });
    version = readVersion(ROOT_PKG);

    // Pure, and therefore the part that refuses: computed before any further write so a bad
    // changelog aborts with only npm's own root bump to undo.
    const withNewSection = bumpChangelog(changelogForBump, version, todayISO());
    const newChangelog = updateChangelogFooterLinks(withNewSection, previousVersion, version);

    writeVersion(CORE_PKG, version);
    writeVersion(WEB_PKG, version);
    execFileSync('npm', ['install', '--package-lock-only'], { cwd: root, stdio: 'inherit' });
    writeFileSync(CHANGELOG, newChangelog);

    for (const docPath of imageRefDocPaths()) {
      const before = readFileSync(docPath, 'utf8');
      const after = pinImageTags(before, version);
      if (after !== before) writeFileSync(docPath, after);
    }
  } catch (err) {
    restore();
    console.error(`\nRelease aborted, working tree restored unchanged.\n${err.message}`);
    process.exit(1);
  }

  execFileSync(
    'git',
    [
      'add',
      'package.json',
      'package-lock.json',
      'packages/core/package.json',
      'packages/web/package.json',
      'CHANGELOG.md',
      ...imageRefDocPaths().map((p) => relative(root, p)),
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
