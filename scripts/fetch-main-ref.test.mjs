// scripts/fetch-main-ref.sh, the step that makes origin/main usable for the release candidate check.
//
// Written after the first real release failed on it. ci.yml ran
//
//     git fetch origin main --depth=0 2>/dev/null || git fetch origin main
//
// against the depth-1 clone actions/checkout produces. `--depth=0` is not valid for git fetch,
// 2>/dev/null hid that, and the fallback never creates refs/remotes/origin/main, so
// check-release-candidate.mjs died with "fatal: Not a valid object name origin/main".
//
// The contract under test is the one that failed: after this runs, `origin/main` resolves AND
// shares history with HEAD. Everything happens in local repositories, so there is no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(root, 'scripts', 'fetch-main-ref.sh');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * An origin with `main` and a `release/v9.9.9` branch off it, plus one later commit on main so the
 * branch is genuinely behind. Returns the path of the bare origin.
 */
function makeOrigin() {
  const dir = mkdtempSync(join(tmpdir(), 'fetch-main-origin-'));
  const work = join(dir, 'work');
  const bare = join(dir, 'origin.git');

  execFileSync('git', ['init', '--bare', '--initial-branch=main', bare]);
  execFileSync('git', ['init', '--initial-branch=main', work]);
  git(work, 'config', 'user.email', 'test@example.com');
  git(work, 'config', 'user.name', 'Test');

  writeFileSync(join(work, 'a.txt'), 'one\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-m', 'first');

  // Several commits, so a depth-1 clone is genuinely missing history rather than trivially complete.
  for (const n of ['two', 'three', 'four']) {
    writeFileSync(join(work, 'a.txt'), `${n}\n`);
    git(work, 'add', '-A');
    git(work, 'commit', '-m', n);
  }

  git(work, 'checkout', '-b', 'release/v9.9.9');
  writeFileSync(join(work, 'release.txt'), 'release\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-m', 'release: v9.9.9');

  git(work, 'checkout', 'main');
  writeFileSync(join(work, 'b.txt'), 'later\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-m', 'later on main');

  git(work, 'remote', 'add', 'origin', bare);
  git(work, 'push', '-q', 'origin', 'main', 'release/v9.9.9');

  return bare;
}

/**
 * Clones the release branch the way actions/checkout does by default: one ref, depth 1.
 *
 * The `file://` prefix matters. Given a plain path, git uses its local transport, which hardlinks
 * the object store and IGNORES --depth entirely, so the clone comes out complete and every
 * assertion below would pass without testing anything.
 */
function shallowClone(bare) {
  const dir = mkdtempSync(join(tmpdir(), 'fetch-main-clone-'));
  const repo = join(dir, 'repo');
  execFileSync('git', ['clone', '--depth', '1', '--branch', 'release/v9.9.9', `file://${bare}`, repo], {
    stdio: 'ignore',
  });
  return repo;
}

function run(repo) {
  execFileSync('bash', [SCRIPT], { cwd: repo, stdio: 'pipe' });
}

test('the default CI clone really is shallow and really is missing origin/main', () => {
  // Guards the premise. If this ever stops holding, the rest of these tests prove nothing.
  const repo = shallowClone(makeOrigin());
  assert.equal(existsSync(join(repo, '.git', 'shallow')), true, 'expected a shallow clone');
  assert.throws(() => git(repo, 'rev-parse', '--verify', 'origin/main'));
});

test('after running, origin/main resolves', () => {
  const repo = shallowClone(makeOrigin());
  run(repo);
  assert.match(git(repo, 'rev-parse', 'origin/main'), /^[0-9a-f]{40}$/);
});

test('after running, merge-base against HEAD works, which is what the checker needs', () => {
  const repo = shallowClone(makeOrigin());
  run(repo);
  assert.match(git(repo, 'merge-base', 'origin/main', 'HEAD'), /^[0-9a-f]{40}$/);
});

test('the clone is no longer shallow, so the history is genuinely there', () => {
  const repo = shallowClone(makeOrigin());
  run(repo);
  assert.equal(existsSync(join(repo, '.git', 'shallow')), false);
});

test('it is idempotent, so a re-run does not fail on an already complete repository', () => {
  // git refuses --unshallow on a complete repository, which is why the shallow check exists.
  const repo = shallowClone(makeOrigin());
  run(repo);
  run(repo);
  assert.match(git(repo, 'merge-base', 'origin/main', 'HEAD'), /^[0-9a-f]{40}$/);
});

test('it works on a clone that was never shallow', () => {
  const bare = makeOrigin();
  const dir = mkdtempSync(join(tmpdir(), 'fetch-main-full-'));
  const repo = join(dir, 'repo');
  execFileSync('git', ['clone', '--branch', 'release/v9.9.9', bare, repo], { stdio: 'ignore' });
  run(repo);
  assert.match(git(repo, 'merge-base', 'origin/main', 'HEAD'), /^[0-9a-f]{40}$/);
});
