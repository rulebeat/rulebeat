#!/usr/bin/env node
// Fails a pull request that changes what ships without recording anything under CHANGELOG.md's
// "## [Unreleased]".
//
// Why this exists: seven dependency PRs merged in one batch with no entry each. Nothing asked for
// one. They would have sat in an unreferenced ghcr.io/...:sha-<commit> image indefinitely, because
// only a pushed vX.Y.Z tag moves :latest. The rule already existed in
// docs/engineering/how-changes-are-made.md ("every PR that changes app behaviour adds a line
// there"); it was simply unenforced and undiscoverable. The decision has to happen at PR time,
// while the author still knows what the change means -- at release time that context is gone.
//
// Scope of the guarantee, stated honestly: this prevents an ACCIDENTAL omission. It is not an
// adversarial control. A fork PR can edit this file or the workflow and report green; that edit is
// plainly visible in the diff, so review is the mitigation. Running it under pull_request_target to
// stop that would be strictly worse: the job would then execute fork-authored code with a writable
// base-repo token.
//
// What counts as shipping is decided against the Dockerfile, not by intuition. The runtime image
// contains only .next/standalone, .next/static, packages/web/public and packages/web/data/packs.
// CI config, docs, tests and every scripts/ directory are therefore exempt: they cannot change what
// a user's container does, and CHANGELOG.md is release notes for people running RuleBeat, not a log
// of the repo's own tooling.
//
// Detection is parse-and-compare, not diff-hunk parsing. Markdown has no diff driver configured
// here, so a hunk header is git's generic heuristic rather than the nearest "##"; and a rebase, a
// merge from main, or reflowing a bullet all move +/- lines without adding an entry. Comparing the
// parsed [Unreleased] bullets of two file versions is immune to all of that, is a pure function of
// two strings, and gets "editing an already-released entry must not count" for free, because the
// parser stops at the next "## [".
//
// Usage: node scripts/check-changelog-entry.mjs
//   env: PR_AUTHOR, PR_HEAD_REF, PR_HEAD_REPO, PR_LABELS (JSON array), BASE_SHA, HEAD_SHA

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { classifyReleasePr } from './check-release-candidate.mjs';

const root = process.env.RELEASE_SCRIPT_ROOT
  ? resolve(process.env.RELEASE_SCRIPT_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const SKIP_LABEL = 'no-changelog';

/**
 * Paths that cannot change what the running app does. Everything NOT matched here counts as
 * shipping -- the default has to be "ships", so a file type nobody thought about fails closed
 * rather than being waved through.
 *
 * Verified against the Dockerfile. Note packages/web/public/** DOES ship (Dockerfile copies it, and
 * the sign-in and error pages reference /brand/mark.png from it): there are two `brand` directories
 * in this repo and only the top-level source kit is inert.
 */
const NON_SHIPPING = [
  /^docs\//,
  /\.md$/,
  /^\.github\//,
  /^brand\//,
  /(^|\/)tests?\//,
  /\.test\.(ts|mts|mjs|js)$/,
  /\.spec\.(ts|mts|mjs|js)$/,
  // Build and release tooling. Verified against the Dockerfile: the runtime stage copies only
  // .next/standalone, .next/static, packages/web/public and packages/web/data/packs, and it
  // explicitly deletes packages/web/scripts from the standalone output. Nothing under any
  // scripts/ directory reaches the image, so changing it cannot change what the app does.
  // (scripts/sync-pack.ts generates packs, but its committed output lands in
  // packages/web/data/packs, which is classified as shipping in its own right.)
  /^scripts\//,
  /^packages\/[^/]+\/scripts\//,
  /^(LICENSE|NOTICE|\.gitignore|\.editorconfig)$/,
];

/** Root and workspace manifests, where only some kinds of change reach the image. */
const MANIFEST = /^(package\.json|packages\/[^/]+\/package\.json)$/;

/** The identity Dependabot's own pull requests arrive under. Not settable by a fork. */
export const DEPENDABOT_AUTHOR = 'dependabot[bot]';

/** A manifest or the lockfile: the complete set of files a pure dependency bump touches. */
const DEPENDENCY_FILE = /^(package-lock\.json|package\.json|packages\/[^/]+\/package\.json)$/;

/**
 * Dependabot's own bumps are exempt, because the note that matters is now derived rather than
 * hand-written: release.mjs runs release-dependency-notes.mjs, which diffs the direct runtime
 * `dependencies` of the two published packages between the previous tag and the release, and
 * writes them into [Unreleased] at release time. A human bullet naming the same package still
 * wins -- 0.2.1's nodemailer entry explained an impact no derived version span could.
 *
 * Requiring a hand-written entry here instead would mean writing, by hand, the exact line the
 * release will generate anyway; and a devDependency bump has no release note to write at all,
 * since nothing about eslint or @types/node reaches the image.
 *
 * The tightening that makes this safe: it applies ONLY when the PR touches nothing but manifests
 * and the lockfile. A dependency branch that also carries source changes is an ordinary product
 * change wearing a Dependabot label, and it is not a hypothetical -- the @azure/arm-resourcegraph
 * 5.0.0 bump needed a real edit to packages/core/src/clients/resource-graph.ts for its moved
 * `timeout` option. Without this clause the exemption would have waved that edit straight through.
 *
 * @param {{ author: string, headRef: string, headRepoFullName: string, repository: string,
 *           changedPaths: string[] }} input
 * @returns {boolean}
 */
export function isDependabotBump({ author, headRef, headRepoFullName, repository, changedPaths }) {
  if (author !== DEPENDABOT_AUTHOR) return false;
  // Dependabot pushes to branches in this repository. A fork cannot claim this identity.
  if (headRepoFullName !== repository) return false;
  if (!headRef.startsWith('dependabot/')) return false;
  return changedPaths.length > 0 && changedPaths.every((p) => DEPENDENCY_FILE.test(p));
}

/**
 * @param {string} path repo-relative
 * @returns {boolean} true when the path can affect the shipped artifact
 */
export function isShippingPath(path) {
  return !NON_SHIPPING.some((re) => re.test(path));
}

/**
 * A manifest is where a dependency bump lives, so it has to count as shipping -- that is the exact
 * case this whole gate was built for. But adding an npm script to it changes nothing in the image,
 * and treating that as shipping would mean every CI or tooling PR needs a label.
 *
 * So: a manifest change ships unless the ONLY top-level key that differs is `scripts`. Anything
 * touching dependencies, version, engines or workspaces still ships. Unparseable JSON on either
 * side counts as shipping, because "I could not tell" must not mean "waved through".
 *
 * @param {string} baseText
 * @param {string} headText
 * @returns {boolean} true when the change can affect the image
 */
export function manifestChangeShips(baseText, headText) {
  let base;
  let head;
  try {
    base = JSON.parse(baseText);
    head = JSON.parse(headText);
  } catch {
    return true;
  }

  const keys = new Set([...Object.keys(base), ...Object.keys(head)]);
  for (const key of keys) {
    if (key === 'scripts') continue;
    if (JSON.stringify(base[key]) !== JSON.stringify(head[key])) return true;
  }
  return false;
}

/**
 * The bullets under "## [Unreleased]", normalized so that reflowing one across different line
 * breaks does not read as a new entry.
 *
 * A bullet runs from a "- " line to the next bullet or the end of the section, so continuation
 * lines are folded into it. Returns null when there is no "## [Unreleased]" header at all, which
 * the caller reports rather than treating as "no entries".
 *
 * @param {string} changelogText
 * @returns {string[]|null}
 */
export function parseUnreleasedBullets(changelogText) {
  const lines = changelogText.split('\n');
  const start = lines.findIndex((l) => l.trim() === '## [Unreleased]');
  if (start === -1) return null;

  let end = lines.findIndex((l, i) => i > start && l.trim().startsWith('## ['));
  if (end === -1) end = lines.length;

  const bullets = [];
  let current = null;
  for (const line of lines.slice(start + 1, end)) {
    if (/^\s*-\s+/.test(line)) {
      if (current !== null) bullets.push(current);
      current = line.replace(/^\s*-\s+/, '');
    } else if (current !== null) {
      if (line.trim() === '' || line.trim().startsWith('#')) {
        bullets.push(current);
        current = null;
      } else {
        current += ` ${line.trim()}`;
      }
    }
  }
  if (current !== null) bullets.push(current);

  return bullets.map((b) => b.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/**
 * @param {{ author: string, headRef: string, headRepoFullName: string, repository: string,
 *           labels: string[], changedPaths: string[], basePackageVersion: string,
 *           baseChangelog: string, headChangelog: string }} input
 * @returns {{ ok: boolean, reason: string, shippingPaths: string[], error?: string }}
 */
export function checkChangelogGate(input) {
  const {
    headRef,
    headRepoFullName,
    repository,
    author,
    labels,
    changedPaths,
    basePackageVersion,
    baseChangelog,
    headChangelog,
    manifests = {},
  } = input;

  // A release PR touches all three manifests (shipping paths) and EMPTIES [Unreleased]: a net
  // removal of every bullet. Without this it would be blocked permanently. Identity is the same
  // predicate tag-release.yml uses -- deliberately not a second, weaker copy, since a branch name
  // alone is something any fork can choose.
  const identity = classifyReleasePr({
    headRef,
    headRepoFullName,
    repository,
    author,
    packageVersion: basePackageVersion,
  });
  if (identity.kind === 'valid') {
    return { ok: true, reason: 'release-pr', shippingPaths: [] };
  }

  if (labels.includes(SKIP_LABEL)) {
    return { ok: true, reason: 'labelled', shippingPaths: [] };
  }

  // Fails closed. An empty list means the git range was computed wrongly, not that a PR somehow
  // changed nothing.
  if (changedPaths.length === 0) {
    return {
      ok: false,
      reason: 'no-changed-paths',
      shippingPaths: [],
      error: 'No changed paths were found. That is a bug in how the diff range was computed, not an empty PR.',
    };
  }

  // After the fail-closed check above, so "no paths" can never be read as a pure dependency bump.
  if (isDependabotBump({ author, headRef, headRepoFullName, repository, changedPaths })) {
    return { ok: true, reason: 'dependabot-bump', shippingPaths: [] };
  }

  const shippingPaths = changedPaths.filter((p) => {
    if (!isShippingPath(p)) return false;
    if (!MANIFEST.test(p)) return true;
    const contents = manifests[p];
    // No content supplied means no refinement is possible, so keep the conservative answer.
    return contents ? manifestChangeShips(contents.base, contents.head) : true;
  });
  if (shippingPaths.length === 0) {
    return { ok: true, reason: 'non-shipping', shippingPaths: [] };
  }

  const baseBullets = parseUnreleasedBullets(baseChangelog);
  const headBullets = parseUnreleasedBullets(headChangelog);

  if (headBullets === null) {
    return {
      ok: false,
      reason: 'no-unreleased-header',
      shippingPaths,
      error: 'CHANGELOG.md has no "## [Unreleased]" header, so there is nowhere to record this change.',
    };
  }

  const before = new Set(baseBullets ?? []);
  const added = headBullets.filter((b) => !before.has(b));

  return added.length > 0
    ? { ok: true, reason: 'entry-added', shippingPaths }
    : { ok: false, reason: 'missing-entry', shippingPaths };
}

/**
 * The teaching version of the failure, kept here rather than in YAML so it is testable.
 *
 * @param {{ reason: string, shippingPaths: string[], error?: string }} result
 * @returns {string} markdown
 */
export function formatGateFailure(result) {
  if (result.error) {
    return `## Changelog entry required\n\n${result.error}\n`;
  }

  const shown = result.shippingPaths.slice(0, 10);
  const more = result.shippingPaths.length - shown.length;

  return [
    '## Changelog entry required',
    '',
    'This pull request changes files that end up in the shipped container image, but adds nothing',
    'under `## [Unreleased]` in `CHANGELOG.md`.',
    '',
    'That matters because only a pushed `vX.Y.Z` tag moves `:latest`. A change with no entry has',
    'nothing to carry it into a release, so it can sit in an unreferenced image indefinitely.',
    '',
    '### Files that triggered this',
    '',
    ...shown.map((p) => `- \`${p}\``),
    ...(more > 0 ? ['', `...and ${more} more.`] : []),
    '',
    '### What to add',
    '',
    'One bullet under `## [Unreleased]` in `CHANGELOG.md`, using the section that fits:',
    '',
    '```markdown',
    '## [Unreleased]',
    '',
    '### Fixed',
    '',
    '- What changed for someone running RuleBeat, and briefly why it happened.',
    '```',
    '',
    '`Added` for a new capability, `Changed` for different behaviour, `Fixed` for a bug, `Security`',
    'for a vulnerability fix. Write what a user would notice, not what the diff does: the existing',
    'entries are the model.',
    '',
    '### If no entry belongs here',
    '',
    `A maintainer can apply the \`${SKIP_LABEL}\` label, which re-runs this check. That label means`,
    '"this genuinely does not affect the shipped runtime" -- it is not a way past the check.',
    '',
    'Docs, tests, CI config and every `scripts/` directory are exempt automatically and need no',
    'label: none of them is in the runtime image, which contains only the built app, its public',
    'assets and its rule packs.',
    '',
  ].join('\n');
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function gitShowOrEmpty(ref, path) {
  try {
    return execFileSync('git', ['show', `${ref}:${path}`], { cwd: root, encoding: 'utf8' });
  } catch {
    return '';
  }
}

function main() {
  const baseSha = process.env.BASE_SHA ?? '';
  const headSha = process.env.HEAD_SHA ?? '';
  if (!baseSha || !headSha) {
    console.error('BASE_SHA and HEAD_SHA are required.');
    process.exit(2);
  }

  let labels = [];
  try {
    labels = JSON.parse(process.env.PR_LABELS ?? '[]');
  } catch {
    labels = [];
  }

  // Two different refs on purpose.
  //
  // Changed paths come from the merge base, which is what this PR actually touched, with
  // --no-renames so a shipping file moved into docs/** is classified by BOTH its old and new path
  // rather than disappearing into an exempt one.
  const mergeBase = git('merge-base', baseSha, headSha);
  const changedPaths = git('diff', '--name-only', '--no-renames', mergeBase, headSha)
    .split('\n')
    .filter(Boolean);

  // [Unreleased] is compared against the CURRENT base, not the merge base. Using the merge base
  // would let a PR that merely merged main in -- inheriting somebody else's bullet -- pass with no
  // entry of its own.
  const baseChangelog = gitShowOrEmpty(baseSha, 'CHANGELOG.md');
  const headChangelog = gitShowOrEmpty(headSha, 'CHANGELOG.md');

  let basePackageVersion = '';
  try {
    basePackageVersion = JSON.parse(gitShowOrEmpty(headSha, 'package.json') || '{}').version ?? '';
  } catch {
    basePackageVersion = '';
  }

  // Only the manifests this PR actually touched, so no needless git calls.
  const manifests = {};
  for (const p of changedPaths) {
    if (/^(package\.json|packages\/[^/]+\/package\.json)$/.test(p)) {
      manifests[p] = { base: gitShowOrEmpty(baseSha, p), head: gitShowOrEmpty(headSha, p) };
    }
  }

  const result = checkChangelogGate({
    author: process.env.PR_AUTHOR ?? '',
    headRef: process.env.PR_HEAD_REF ?? '',
    headRepoFullName: process.env.PR_HEAD_REPO ?? '',
    repository: process.env.GITHUB_REPOSITORY ?? '',
    labels,
    changedPaths,
    basePackageVersion,
    baseChangelog,
    headChangelog,
    manifests,
  });

  if (result.ok) {
    const explain = {
      'release-pr': 'Release PR: the release itself empties [Unreleased].',
      labelled: `Labelled \`${SKIP_LABEL}\` by a maintainer.`,
      'dependabot-bump': 'Dependency bump: the release derives its own note from the manifests.',
      'non-shipping': 'Nothing here reaches the shipped image.',
      'entry-added': 'A new [Unreleased] entry was added.',
    }[result.reason];
    console.log(`Changelog check passed. ${explain}`);
    return;
  }

  const summary = formatGateFailure(result);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
  console.error(summary);
  console.error(
    `::error file=CHANGELOG.md::This PR changes shipped behaviour but adds nothing under [Unreleased] in CHANGELOG.md. Add one bullet, or ask a maintainer for the \`${SKIP_LABEL}\` label.`
  );
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
