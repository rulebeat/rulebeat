// The builder dependency check. Written after the Docker builder stage spent an entire release
// resolving nodemailer to a hoisted 8.0.11 optional peer of another package instead of the ^9.0.5
// packages/web declares, because it copied only the root node_modules and .dockerignore excluded
// the workspace ones.
//
// The contract: a dependency that resolves to a DIFFERENT copy than the manifest declares is the
// same fault as one that does not resolve at all, and both fail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  majorOf,
  declaredMajor,
  checkResolvedDeps,
  resolvedVersion,
} from './verify-builder-deps.mjs';

/** Writes node_modules/<name>/package.json at `dir` with the given version. */
function installFixture(dir, name, version) {
  const pkgDir = join(dir, 'node_modules', ...name.split('/'));
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, version }));
}

// ------------------------------------------------------------ version parsing

test('majorOf reads the major, and refuses to guess at nonsense', () => {
  assert.equal(majorOf('9.0.5'), '9');
  assert.equal(majorOf('13.0.3'), '13');
  assert.equal(majorOf('not-a-version'), null);
  assert.equal(majorOf(undefined), null);
});

test('declaredMajor reads the pinned major from the common range shapes', () => {
  assert.equal(declaredMajor('^9.0.5'), '9');
  assert.equal(declaredMajor('~2.1.0'), '2');
  assert.equal(declaredMajor('8.0.1'), '8');
  assert.equal(declaredMajor('^20'), '20');
});

test('a range that pins no major is skipped rather than guessed at', () => {
  // A false failure here would block every image build, so these must return null.
  assert.equal(declaredMajor('*'), null);
  assert.equal(declaredMajor('>=1.0.0'), null);
  assert.equal(declaredMajor('workspace:*'), null);
  assert.equal(declaredMajor('github:someone/thing'), null);
});

// ------------------------------------------------------------ the decision

const OK_ENTRY = Object.freeze({
  workspace: 'packages/web',
  name: 'nodemailer',
  range: '^9.0.5',
  version: '9.0.5',
});

test('a tree where everything matches passes', () => {
  const result = checkResolvedDeps([OK_ENTRY, { ...OK_ENTRY, name: 'better-sqlite3', range: '^13.0.3', version: '13.0.3' }]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('the exact production fault: resolving to a different major than declared FAILS', () => {
  const result = checkResolvedDeps([{ ...OK_ENTRY, version: '8.0.11' }]);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /nodemailer resolves to 8\.0\.11 but the manifest declares \^9\.0\.5/);
});

test('a dependency that does not resolve at all fails, and says which', () => {
  const result = checkResolvedDeps([{ ...OK_ENTRY, version: null }]);
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /nodemailer \(declared \^9\.0\.5\) does not resolve/);
});

test('an unpinnable range is not judged on its version', () => {
  const result = checkResolvedDeps([{ ...OK_ENTRY, range: '*', version: '1.2.3' }]);
  assert.equal(result.ok, true);
});

test('an unpinnable range still has to resolve to something', () => {
  const result = checkResolvedDeps([{ ...OK_ENTRY, range: '*', version: null }]);
  assert.equal(result.ok, false);
});

test('every mismatch is reported, not just the first', () => {
  const result = checkResolvedDeps([
    { ...OK_ENTRY, version: '8.0.11' },
    { ...OK_ENTRY, name: 'better-sqlite3', range: '^13.0.3', version: null },
  ]);
  assert.equal(result.errors.length, 2);
});

// ------------------------------------------------------------ locating a package

test('a copy nested in the workspace WINS over a hoisted one, as it does at runtime', () => {
  // This is the whole bug in one assertion. Both copies exist; the workspace's own must win.
  const root = mkdtempSync(join(tmpdir(), 'builder-deps-'));
  const workspace = join(root, 'packages', 'web');
  mkdirSync(workspace, { recursive: true });
  installFixture(root, 'nodemailer', '8.0.11');
  installFixture(workspace, 'nodemailer', '9.0.5');

  assert.equal(resolvedVersion(workspace, 'nodemailer'), '9.0.5');
});

test('with the workspace copy gone it falls back to the hoisted one, which is how this went unnoticed', () => {
  const root = mkdtempSync(join(tmpdir(), 'builder-deps-'));
  const workspace = join(root, 'packages', 'web');
  mkdirSync(workspace, { recursive: true });
  installFixture(root, 'nodemailer', '8.0.11');

  assert.equal(resolvedVersion(workspace, 'nodemailer'), '8.0.11');
});

test('a scoped name resolves through its two path segments', () => {
  const root = mkdtempSync(join(tmpdir(), 'builder-deps-'));
  const workspace = join(root, 'packages', 'core');
  mkdirSync(workspace, { recursive: true });
  installFixture(root, '@azure/identity', '4.13.2');

  assert.equal(resolvedVersion(workspace, '@azure/identity'), '4.13.2');
});

test('nothing installed anywhere resolves to null, never a throw', () => {
  const root = mkdtempSync(join(tmpdir(), 'builder-deps-'));
  const workspace = join(root, 'packages', 'web');
  mkdirSync(workspace, { recursive: true });

  assert.equal(resolvedVersion(workspace, 'nodemailer'), null);
});

test('a package with no JavaScript entry point still resolves', () => {
  // tw-animate-css ships only CSS and exports it under a `style` condition, so require.resolve
  // throws on a healthy install. Locating the directory must not care what a package exports.
  const root = mkdtempSync(join(tmpdir(), 'builder-deps-'));
  const workspace = join(root, 'packages', 'web');
  mkdirSync(workspace, { recursive: true });
  const pkgDir = join(root, 'node_modules', 'tw-animate-css');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'tw-animate-css', version: '1.4.0', exports: { '.': { style: './dist/x.css' } } })
  );

  assert.equal(resolvedVersion(workspace, 'tw-animate-css'), '1.4.0');
});
