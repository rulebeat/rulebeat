#!/usr/bin/env node
// Refuses a release whose git tag disagrees with what package.json/CHANGELOG.md actually say, so
// a published Docker image can never claim a version the running app itself doesn't report
// (packages/web/lib/version.ts reads straight from package.json). Called by
// .github/workflows/publish-image.yml before it retags anything, so this runs even for a tag
// pushed by hand with no release script involved.
//
// Usage: node scripts/verify-release-version.mjs <vX.Y.Z or X.Y.Z>  (or set GITHUB_REF_NAME)

import { readFileSync } from 'node:fs';
import { checkChangelogStructure } from './check-changelog-structure.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PACKAGE_JSON_PATHS = [
  'package.json',
  'packages/core/package.json',
  'packages/web/package.json',
];

/**
 * Pure check, no filesystem access, so it is directly testable against fixtures rather than only
 * through the CLI.
 *
 * @param {{ version: string, packageVersions: Record<string, string>, changelogText: string }} input
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function checkReleaseVersion({ version, packageVersions, changelogText }) {
  const errors = [];

  for (const [path, pkgVersion] of Object.entries(packageVersions)) {
    if (pkgVersion !== version) {
      errors.push(`${path} says version "${pkgVersion}", but the pushed tag is v${version}.`);
    }
  }

  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headerPattern = new RegExp(`^## \\[${escapedVersion}\\] - (.+)$`, 'm');
  const match = changelogText.match(headerPattern);

  if (!match) {
    errors.push(`CHANGELOG.md has no "## [${version}]" header.`);
  } else {
    const date = match[1].trim();
    const looksLikeADate = /^\d{4}-\d{2}-\d{2}$/.test(date);
    if (!looksLikeADate) {
      errors.push(
        `CHANGELOG.md's "## [${version}]" header's date is "${date}", not a real date ` +
          `(expected YYYY-MM-DD) — looks like the release was never finished.`
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

function stripLeadingV(tag) {
  return tag.startsWith('v') ? tag.slice(1) : tag;
}

function readPackageVersions() {
  const versions = {};
  for (const path of PACKAGE_JSON_PATHS) {
    const pkg = JSON.parse(readFileSync(resolve(root, path), 'utf8'));
    versions[path] = pkg.version;
  }
  return versions;
}

function main() {
  const rawTag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
  if (!rawTag) {
    console.error('Usage: node scripts/verify-release-version.mjs <tag>  (or set GITHUB_REF_NAME)');
    process.exit(2);
  }

  const version = stripLeadingV(rawTag);
  const packageVersions = readPackageVersions();
  const changelogText = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');

  const { errors } = checkReleaseVersion({ version, packageVersions, changelogText });

  // Internal consistency of CHANGELOG.md itself, checked here rather than inside
  // checkReleaseVersion() so that pure function's contract and its tests stay unchanged. Both run
  // in tag-release.yml and publish-image.yml, so the invariants gate tagging AND promotion without
  // touching either workflow. Errors are concatenated so one run reports everything wrong at once.
  const structure = checkChangelogStructure(changelogText);
  const allErrors = [...errors, ...structure.errors];

  if (allErrors.length > 0) {
    console.error(`Tag v${version} does not match the repo's own version records:`);
    for (const err of allErrors) console.error(`  - ${err}`);
    console.error(
      "\nFix package.json/CHANGELOG.md to agree with this tag, or delete and retag with the " +
        'right version, before this release can be promoted.'
    );
    process.exit(1);
  }

  console.log(`v${version} matches all three package.json files, and CHANGELOG.md is internally consistent. OK.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
