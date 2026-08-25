// scripts/resolve-pr-context.sh, the step that feeds check-changelog-entry.mjs.
//
// This file exists because of a specific outage. The resolution used to be written inline in
// pr-checks.yml as `echo 'labels=${{ toJSON(github.event.pull_request.labels.*.name) }}'`.
// toJSON pretty-prints, so a single label became three lines, and $GITHUB_OUTPUT's key=value form
// rejected the whole step with `Invalid format '  "dependencies"'`. Every labelled pull request
// failed the check before the checker ran, including any carrying `no-changelog` -- the label
// whose entire purpose is to unblock a pull request guaranteed it could never pass.
//
// The invariant under test is therefore not "labels are parsed" but "NOTHING written to
// $GITHUB_OUTPUT can span more than one line", whatever the payload contains.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(root, 'scripts', 'resolve-pr-context.sh');

/** Runs the real script against a fixture event payload and returns the parsed $GITHUB_OUTPUT. */
function resolveContext(pullRequest) {
  const dir = mkdtempSync(join(tmpdir(), 'pr-context-'));
  const eventPath = join(dir, 'event.json');
  const outputPath = join(dir, 'output.txt');
  writeFileSync(eventPath, JSON.stringify({ pull_request: pullRequest }));
  writeFileSync(outputPath, '');

  execFileSync('bash', [SCRIPT], {
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: outputPath,
    },
  });

  const raw = readFileSync(outputPath, 'utf8');
  const lines = raw.split('\n').filter((l) => l !== '');
  return { raw, lines, values: Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])) };
}

/** The shape GitHub actually sends, with however many labels the caller wants. */
function payload(labelNames) {
  return {
    base: { sha: 'a'.repeat(40) },
    head: { sha: 'b'.repeat(40), ref: 'dependabot/npm_and_yarn/eslint-10.9.0', repo: { full_name: 'rulebeat/rulebeat' } },
    user: { login: 'dependabot[bot]' },
    labels: labelNames.map((name) => ({ name })),
  };
}

test('a single label stays on ONE line -- the exact shape that broke every Dependabot PR', () => {
  const { lines, values } = resolveContext(payload(['dependencies']));
  assert.equal(lines.length, 6, `expected 6 key=value lines, got:\n${lines.join('\n')}`);
  assert.equal(values.labels, '["dependencies"]');
});

test('the no-changelog label resolves too, so the escape hatch actually works', () => {
  const { values } = resolveContext(payload(['no-changelog']));
  assert.equal(values.labels, '["no-changelog"]');
  assert.equal(JSON.parse(values.labels).includes('no-changelog'), true);
});

test('no labels at all -- the case that hid the bug for so long', () => {
  const { lines, values } = resolveContext(payload([]));
  assert.equal(lines.length, 6);
  assert.equal(values.labels, '[]');
});

test('every value is single-line no matter how many labels there are', () => {
  const { lines, values } = resolveContext(payload(['dependencies', 'no-changelog', 'security']));
  assert.equal(lines.length, 6);
  assert.deepEqual(JSON.parse(values.labels), ['dependencies', 'no-changelog', 'security']);
});

test('a label containing a newline still cannot break the output format', () => {
  // jq -c escapes it into the JSON string rather than emitting a second line.
  const { lines, values } = resolveContext(payload(['we\nbroke\nit']));
  assert.equal(lines.length, 6, `a newline in a label escaped into $GITHUB_OUTPUT:\n${lines.join('\n')}`);
  assert.deepEqual(JSON.parse(values.labels), ['we\nbroke\nit']);
});

test('the remaining fields are carried through verbatim', () => {
  const { values } = resolveContext(payload(['dependencies']));
  assert.equal(values.base_sha, 'a'.repeat(40));
  assert.equal(values.head_sha, 'b'.repeat(40));
  assert.equal(values.head_ref, 'dependabot/npm_and_yarn/eslint-10.9.0');
  assert.equal(values.head_repo, 'rulebeat/rulebeat');
  assert.equal(values.author, 'dependabot[bot]');
});

test('a branch name with shell metacharacters is data, never executed', () => {
  const hostile = 'fix/$(touch /tmp/rulebeat-pwned)`whoami`';
  const p = payload([]);
  p.head.ref = hostile;
  const { values } = resolveContext(p);
  assert.equal(values.head_ref, hostile);
});
