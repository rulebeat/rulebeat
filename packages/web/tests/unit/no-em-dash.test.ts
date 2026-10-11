/**
 * Architecture test: no tracked file in the repo holds an em dash (U+2014).
 *
 * The copy rule is one rule for the whole repository: product strings, docs, comments, test titles,
 * assertion messages, workflow and script log lines. There is no "is this visible to a user?" line to
 * argue over and no allowlist. `git grep -I` skips binary files, so an image cannot trip it by chance.
 * The sweep asserts it saw the repo, so it cannot pass by finding nothing, and it fails outright when
 * git is not available rather than passing unchecked.
 *
 * This file builds the character from its code point so that it does not trip itself.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const EM_DASH = String.fromCharCode(0x2014);
/** The repo tracked 941 files when this guard landed; a sweep that sees far fewer is not sweeping the repo. */
const MIN_TRACKED_FILES = 900;

function git(args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** `file:line` for every line of every tracked text file that holds an em dash. */
function findEmDashes(): string[] {
  let out: string;
  try {
    out = git(['grep', '-nI', '-F', '-e', EM_DASH]);
  } catch (err) {
    // `git grep` exits 1 when nothing matches, which is the passing case. Any other failure
    // (git missing, not a repository) must fail the test, not pass it.
    const failure = err as { status?: number | null; stdout?: string };
    if (failure.status === 1 && !failure.stdout) return [];
    throw err;
  }
  return out
    .split('\n')
    .filter(Boolean)
    .map(hit => hit.split(':').slice(0, 2).join(':'));
}

describe('no em dash anywhere in the repo', () => {
  it('sweeps the whole repository, not just one package', () => {
    const tracked = git(['ls-files']).split('\n').filter(Boolean);
    expect(tracked.length).toBeGreaterThan(MIN_TRACKED_FILES);
    expect(tracked).toContain('CLAUDE.md');
    expect(tracked).toContain('packages/core/src/index.ts');
  });

  it('finds no em dash in any tracked text file', () => {
    const offenders = findEmDashes();
    expect(
      offenders,
      `Em dash found. Use a full stop, colon, comma or parentheses instead:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
