#!/usr/bin/env node
// Decides two things about a merged pull request, both of which the release pipeline used to take
// on trust:
//
//   1. Is this actually a release PR?  tag-release.yml used to answer this with
//      startsWith(head.ref, 'release/v'), which is a string anybody can choose -- a fork could name
//      its branch release/v9.9.9 and reach the tagging path. Identity now requires the branch name,
//      the source repository, the author, and the version to all agree.
//
//   2. Is the release candidate itself well formed?  A release branch that sat open while main
//      moved can pick up a newly added [Unreleased] entry, leaving it on the wrong side of the new
//      version header -- silently missing the release it actually shipped in. v0.2.0 came within
//      one lucky three-way merge of exactly that.
//
// Both are pure functions over plain data so they are testable without git or a GitHub payload,
// matching scripts/verify-release-version.mjs's shape (pure core, impure main()).
//
// Usage: node scripts/check-release-candidate.mjs --merge-commit <sha>
//   env: PR_HEAD_REF, PR_HEAD_REPO, PR_AUTHOR, GITHUB_REPOSITORY

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = process.env.RELEASE_SCRIPT_ROOT
  ? resolve(process.env.RELEASE_SCRIPT_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Exactly the files scripts/release.mjs writes. A release PR may contain nothing else. */
export const RELEASE_FILES = Object.freeze([
  'CHANGELOG.md',
  'README.md',
  'package-lock.json',
  'package.json',
  'packages/core/package.json',
  'packages/web/package.json',
]);

/**
 * release.mjs's pinImageTags also rewrites the image version pin in every top-level markdown
 * page under docs/public/, so those may change on a release branch too (and nothing nested
 * or non-markdown under it).
 */
export const RELEASE_DOC_PATTERN = /^docs\/public\/[^/]+\.md$/;

/** The identity prepare-release.yml commits and pushes as. */
export const RELEASE_AUTHOR = 'github-actions[bot]';

const RELEASE_BRANCH_EXACT = /^release\/v(\d+\.\d+\.\d+)$/;

/**
 * Classifies a merged PR as one of three things, deliberately distinguishing "not a release" from
 * "claims to be a release but isn't trustworthy". A caller must skip the first quietly and fail
 * loudly on the last -- silently skipping a spoofed release-shaped PR would hide the attack it is
 * meant to catch.
 *
 * @param {{ headRef: string, headRepoFullName: string, repository: string, author: string,
 *           packageVersion: string }} input
 * @returns {{ kind: 'not-release'|'valid'|'invalid', version: string|null, errors: string[] }}
 */
export function classifyReleasePr({
  headRef,
  headRepoFullName,
  repository,
  author,
  packageVersion,
}) {
  // Anything not even shaped like a release branch is an ordinary PR. Note this is the loose
  // prefix on purpose: `release/v1.2` and `release/nonsense` are release-shaped but malformed, and
  // must reach the strict checks below rather than being waved through as ordinary.
  if (!headRef.startsWith('release/')) {
    return { kind: 'not-release', version: null, errors: [] };
  }

  const errors = [];

  const match = RELEASE_BRANCH_EXACT.exec(headRef);
  if (!match) {
    errors.push(
      `Branch "${headRef}" is release-shaped but does not match release/vX.Y.Z exactly.`
    );
  }
  const version = match ? match[1] : null;

  if (headRepoFullName !== repository) {
    errors.push(
      `Release branches must live in ${repository}; this one came from ${headRepoFullName}.`
    );
  }

  if (author !== RELEASE_AUTHOR) {
    errors.push(`Release PRs are opened by ${RELEASE_AUTHOR}; this one is by ${author}.`);
  }

  if (version && version !== packageVersion) {
    errors.push(
      `Branch says v${version} but package.json says ${packageVersion}.`
    );
  }

  return errors.length === 0
    ? { kind: 'valid', version, errors: [] }
    : { kind: 'invalid', version, errors };
}

/**
 * Returns the lines of CHANGELOG.md's "## [Unreleased]" section, or null when there is no such
 * header. Stops at the next "## [" so an already-released section is never read.
 *
 * @param {string} changelogText
 * @returns {string[]|null}
 */
export function unreleasedSectionLines(changelogText) {
  const lines = changelogText.split('\n');
  const start = lines.findIndex((l) => l.trim() === '## [Unreleased]');
  if (start === -1) return null;

  let end = lines.findIndex((l, i) => i > start && l.trim().startsWith('## ['));
  if (end === -1) end = lines.length;
  return lines.slice(start + 1, end);
}

/**
 * The newest released version header, i.e. the first "## [X.Y.Z] - date" below [Unreleased].
 *
 * @param {string} changelogText
 * @returns {{ version: string, date: string }|null}
 */
export function newestReleasedHeader(changelogText) {
  for (const line of changelogText.split('\n')) {
    const m = /^## \[(\d+\.\d+\.\d+)\] - (.+)$/.exec(line.trim());
    if (m) return { version: m[1], date: m[2].trim() };
  }
  return null;
}

/**
 * Validates the release candidate itself. Pure; every input is plain data.
 *
 * `changedPaths` is the release branch measured against its own merge base -- NOT the merge commit
 * against main. A release legitimately contains every product change merged into main through its
 * merge SHA; those were reviewed in their own PRs. What must be limited to the release files is the
 * transformation the release branch itself introduced.
 *
 * @param {{ changelogText: string, packageVersions: Record<string,string>, version: string,
 *           changedPaths: string[] }} input
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function checkReleaseCandidate({ changelogText, packageVersions, version, changedPaths }) {
  const errors = [];

  // 1. Every manifest, and the newest changelog header, agree on the version being released.
  for (const [path, pkgVersion] of Object.entries(packageVersions)) {
    if (pkgVersion !== version) {
      errors.push(`${path} says version "${pkgVersion}", but this release is v${version}.`);
    }
  }

  const newest = newestReleasedHeader(changelogText);
  if (!newest) {
    errors.push('CHANGELOG.md has no released "## [X.Y.Z] - date" header at all.');
  } else if (newest.version !== version) {
    errors.push(
      `CHANGELOG.md's newest release header is [${newest.version}], but this release is v${version}.`
    );
  }

  // 2. [Unreleased] must be empty at the commit being tagged. A non-empty one means work landed on
  //    the branch after the release transformation was generated, and would ship unrecorded.
  const unreleased = unreleasedSectionLines(changelogText);
  if (unreleased === null) {
    errors.push('CHANGELOG.md has no "## [Unreleased]" header.');
  } else {
    const stray = unreleased.filter((l) => /^\s*-\s+/.test(l));
    if (stray.length > 0) {
      errors.push(
        `CHANGELOG.md's "## [Unreleased]" section is not empty at this commit (${stray.length} ` +
          `entr${stray.length === 1 ? 'y' : 'ies'}). Work landed after the release was prepared; ` +
          'those entries would ship in this release without being recorded in it. Regenerate the ' +
          'release from the current base.'
      );
    }
  }

  // 3. The release branch's own diff introduces nothing but the release transformation.
  const unexpected = changedPaths.filter(
    (p) => !RELEASE_FILES.includes(p) && !RELEASE_DOC_PATTERN.test(p)
  );
  if (unexpected.length > 0) {
    errors.push(
      `A release branch may only change ${RELEASE_FILES.join(', ')} and docs/public/*.md -- ` +
        `it also changed: ${unexpected.join(', ')}.`
    );
  }

  return { ok: errors.length === 0, errors };
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function readPackageVersions() {
  const paths = ['package.json', 'packages/core/package.json', 'packages/web/package.json'];
  const versions = {};
  for (const p of paths) {
    versions[p] = JSON.parse(readFileSync(resolve(root, p), 'utf8')).version;
  }
  return versions;
}

/**
 * The release branch's own change set, derived entirely from the commit the PR merged as.
 *
 * Both merge strategies have to work, because which one a repository uses is a repository setting
 * nobody thinks about at release time. This assumed a merge commit and threw on anything else,
 * which killed the v0.2.2 tagging run: v0.2.0 had been merged with a merge commit, the repository
 * squash-merges now, and nothing had exercised the difference in between.
 *
 *  - Two parents (merge commit): parent 1 is main before the merge and parent 2 is the branch tip,
 *    so their merge base is the branch point and the diff to parent 2 is the branch's own work.
 *  - One parent (squash or fast-forward): the commit IS the branch's whole change set, so its own
 *    diff against its parent is exactly that, with no merge base to find.
 *
 * Anything else is not a pull-request merge and is refused rather than guessed at.
 *
 * @param {string} mergeCommit
 * @returns {string[]} repo-relative paths the release branch itself changed
 */
export function releaseBranchChangedPaths(mergeCommit, run = git) {
  const parents = run('rev-list', '--parents', '-n', '1', mergeCommit).split(/\s+/).slice(1);

  if (parents.length === 1) {
    return run('diff', '--name-only', '--no-renames', parents[0], mergeCommit)
      .split('\n')
      .filter(Boolean);
  }

  if (parents.length === 2) {
    const [mainSide, branchSide] = parents;
    const base = run('merge-base', mainSide, branchSide);
    return run('diff', '--name-only', '--no-renames', base, branchSide).split('\n').filter(Boolean);
  }

  throw new Error(
    `${mergeCommit} has ${parents.length} parent(s). A pull request merges as either a 2-parent ` +
      'merge commit or a 1-parent squash, so this is neither.'
  );
}

function main() {
  const mergeCommitFlag = process.argv.indexOf('--merge-commit');
  const mergeCommit = mergeCommitFlag === -1 ? null : process.argv[mergeCommitFlag + 1];
  // CI runs on the release branch itself, where there may be no pull-request payload at all (the
  // run prepare-release.yml dispatches is a workflow_dispatch). Identity is a property of the PR,
  // so it is skipped there; tag-release.yml remains the place that checks it.
  const candidateOnly = process.argv.includes('--candidate-only');

  const packageVersions = readPackageVersions();
  const packageVersion = packageVersions['package.json'];

  if (candidateOnly) {
    const base = git('merge-base', 'origin/main', 'HEAD');
    const changedPaths = git('diff', '--name-only', '--no-renames', base, 'HEAD')
      .split('\n')
      .filter(Boolean);
    const result = checkReleaseCandidate({
      changelogText: readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8'),
      packageVersions,
      version: packageVersion,
      changedPaths,
    });
    if (!result.ok) {
      console.error(`Release candidate v${packageVersion} is not valid:`);
      for (const e of result.errors) console.error(`  - ${e}`);
      process.exit(1);
    }
    console.log(`Release candidate v${packageVersion} looks good.`);
    return;
  }

  const identity = classifyReleasePr({
    headRef: process.env.PR_HEAD_REF ?? '',
    headRepoFullName: process.env.PR_HEAD_REPO ?? '',
    repository: process.env.GITHUB_REPOSITORY ?? '',
    author: process.env.PR_AUTHOR ?? '',
    packageVersion,
  });

  if (identity.kind === 'not-release') {
    console.log('Not a release PR; nothing to do.');
    writeOutput('is_release', 'false');
    return;
  }

  if (identity.kind === 'invalid') {
    // Loud, not silent: a PR shaped like a release that fails identity is the case this exists for.
    console.error('This PR looks like a release but failed identity checks:');
    for (const e of identity.errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  let changedPaths = [];
  if (mergeCommit) {
    changedPaths = releaseBranchChangedPaths(mergeCommit);
  } else {
    const base = git('merge-base', 'origin/main', 'HEAD');
    changedPaths = git('diff', '--name-only', '--no-renames', base, 'HEAD')
      .split('\n')
      .filter(Boolean);
  }

  const result = checkReleaseCandidate({
    changelogText: readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8'),
    packageVersions,
    version: identity.version,
    changedPaths,
  });

  if (!result.ok) {
    console.error(`Release candidate v${identity.version} is not valid:`);
    for (const e of result.errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  console.log(`Release candidate v${identity.version} looks good.`);
  writeOutput('is_release', 'true');
  writeOutput('version', identity.version);
}

function writeOutput(key, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  execFileSync('sh', ['-c', `printf '%s=%s\\n' "$1" "$2" >> "$3"`, 'sh', key, value, file]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
