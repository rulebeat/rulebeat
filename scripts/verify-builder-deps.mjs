#!/usr/bin/env node
// Asserts that every declared runtime dependency of a workspace package actually resolves from
// that package, at the major version the manifest asks for.
//
// Why this exists: the Docker builder stage used to copy only /app/node_modules. npm does not
// hoist everything there -- with these manifests it nests nodemailer and typescript under
// packages/web/node_modules -- and .dockerignore excludes those paths, so that directory was
// simply absent while `next build` ran. dispatch.ts reaches nodemailer through a dynamic
// `import('nodemailer')`, Node resolution walked UP to the root, and it found nodemailer@8.0.11
// sitting there as an OPTIONAL PEER of another package instead of the ^9.0.5 packages/web
// declares. The build succeeded on a package nothing had asked for, and `output: 'standalone'`
// traced that copy into the shipped image. CHANGELOG 0.2.1 announced a nodemailer 9.0.5 security
// update while the image plausibly carried 8.0.11.
//
// Nothing caught it because resolving to the WRONG package looks identical to resolving to the
// right one. It only became visible when two unrelated dependency bumps dropped the 8.0.11 entry
// from the lockfile and the build finally failed with module-not-found. That is the failure mode
// worth guarding: not "is it missing" but "is it the one we declared".
//
// Run from the repo root: node scripts/verify-builder-deps.mjs

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, parse } from 'node:path';

const root = process.env.RELEASE_SCRIPT_ROOT
  ? resolve(process.env.RELEASE_SCRIPT_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The workspace packages whose runtime dependencies end up in the image. */
export const WORKSPACES = Object.freeze(['packages/core', 'packages/web']);

/**
 * The major from a concrete version. Returns null for anything unparseable rather than guessing.
 *
 * @param {string} version e.g. '9.0.5'
 * @returns {string|null}
 */
export function majorOf(version) {
  const m = /^(\d+)\./.exec(String(version ?? ''));
  return m ? m[1] : null;
}

/**
 * The major a dependency range pins to, or null when the range does not pin one.
 *
 * `^9.0.5` and `~9.0` and `9.x` all mean 9. `*`, `>=1`, a git URL or a `workspace:` protocol pin
 * nothing this check can assert, so they are skipped rather than guessed at: a false failure here
 * would block every image build.
 *
 * @param {string} range
 * @returns {string|null}
 */
export function declaredMajor(range) {
  const m = /^[\^~]?(\d+)(?:[.\d]|$)/.exec(String(range ?? '').trim());
  return m ? m[1] : null;
}

/**
 * The pure half: given what each dependency resolved to, decide whether the tree is sound.
 *
 * A dependency that did not resolve at all is an error; so is one whose resolved major differs
 * from the declared major. Both are the same underlying fault -- the builder is not looking at
 * the package the manifest describes.
 *
 * @param {{workspace: string, name: string, range: string, version: string|null}[]} entries
 * @returns {{ok: boolean, errors: string[]}}
 */
export function checkResolvedDeps(entries) {
  const errors = [];

  for (const { workspace, name, range, version } of entries) {
    if (version === null) {
      errors.push(`${workspace}: ${name} (declared ${range}) does not resolve from this workspace.`);
      continue;
    }
    const want = declaredMajor(range);
    const got = majorOf(version);
    if (want === null) continue;
    if (got !== want) {
      errors.push(
        `${workspace}: ${name} resolves to ${version} but the manifest declares ${range}. ` +
          `The builder is looking at a different copy than the one declared.`
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * The version of an installed package, located the way Node locates the package DIRECTORY: walk up
 * from the workspace checking each node_modules along the way.
 *
 * Deliberately not `require.resolve(name)`. That resolves an ENTRY POINT, and a package with no
 * JavaScript entry legitimately has none: tw-animate-css ships only CSS and exports it under a
 * `style` condition, so require.resolve throws on a perfectly healthy install. Reading the
 * directory's own package.json answers "which copy is here" without caring what it exports.
 *
 * @param {string} startDir absolute path of the workspace to resolve from
 * @param {string} name package name, scoped names included
 * @returns {string|null} the installed version, or null when no copy is reachable
 */
export function resolvedVersion(startDir, name) {
  const segments = name.split('/');
  let dir = startDir;
  const stop = parse(dir).root;

  for (;;) {
    const manifest = join(dir, 'node_modules', ...segments, 'package.json');
    if (existsSync(manifest)) {
      try {
        return JSON.parse(readFileSync(manifest, 'utf8')).version ?? null;
      } catch {
        return null;
      }
    }
    if (dir === stop) return null;
    dir = dirname(dir);
  }
}

function collect() {
  const entries = [];

  for (const workspace of WORKSPACES) {
    const manifestPath = join(root, workspace, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const deps = JSON.parse(readFileSync(manifestPath, 'utf8')).dependencies ?? {};

    // Resolution starts where the app's own code lives, so a nested workspace copy is preferred
    // over a hoisted one exactly as it would be at runtime.
    const from = join(root, workspace);

    for (const [name, range] of Object.entries(deps)) {
      entries.push({ workspace, name, range, version: resolvedVersion(from, name) });
    }
  }

  return entries;
}

function main() {
  const entries = collect();
  if (entries.length === 0) {
    console.error('No workspace dependencies were found. That is a bug in this check, not an empty tree.');
    process.exit(2);
  }

  const { ok, errors } = checkResolvedDeps(entries);
  if (ok) {
    console.log(`Builder dependency check passed. ${entries.length} runtime dependencies resolve as declared.`);
    return;
  }

  console.error('Builder dependency check failed.\n');
  for (const e of errors) console.error(`  ${e}`);
  console.error('\nThis usually means a workspace node_modules directory did not reach this stage.');
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
