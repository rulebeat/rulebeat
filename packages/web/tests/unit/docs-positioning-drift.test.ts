/**
 * Architecture test: the product describes itself with one sentence, everywhere, and names its
 * license only where a license belongs.
 *
 * Positioning is owned by the launch-operations repo (its context/positioning.md) and restated here
 * verbatim. By 2026-09-07 five different one-liners had accumulated across the README, the docs
 * index, the docs site description, the app's metadata and package.json, and nothing noticed: a
 * search engine or an AI assistant asked "what is RuleBeat?" got a different answer from each. The
 * same rewrite moved the license name out of positioning copy ("open source" is the word; the
 * license is a fact for License sections). docs/engineering/conventions/content.md records the
 * lesson that updating the owning doc never propagates to the docs that merely repeat it; this test
 * is the mechanical form of that lesson.
 *
 * To change the sentence: change it in the launch-operations repo first, then in every file listed
 * in RESTATING_FILES, then here. Fix the copy, not this test.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_ROOT = join(WEB_ROOT, '..', '..');

/** Positioning line 1, verbatim. */
const LINE_1 =
  'RuleBeat is an open-source, self-hosted Azure governance tool. It runs the rules you create and customize on a schedule and tracks every finding until it is fixed.';

/** Every file that restates line 1. The website restates it too, through its claims sync. */
const RESTATING_FILES = [
  'README.md',
  'docs/public/README.md',
  'docs/mkdocs.yml',
  'packages/web/app/layout.tsx',
  'packages/web/app/opengraph-image.alt.txt',
  'package.json',
];

/** Where the license name may appear, and how it is recognised there. */
const LICENSE_NAME = /Apache/;
const LICENSE_ALLOWED: Array<{ file: string; allowed: (line: string, section: string | null) => boolean }> = [
  // The badge row and the License section, nothing else.
  { file: 'README.md', allowed: (line, section) => /img\.shields\.io\/github\/license/.test(line) || section === '## License' },
  // The answer to "is it free?", which is a licensing question.
  { file: 'docs/public/faq.md', allowed: (_line, section) => section === '## Is it really free?' },
  // The one sentence naming the license contributions fall under.
  { file: 'CONTRIBUTING.md', allowed: (line) => /Apache-2\.0 license/.test(line) },
];

/** Files scanned for the license name: every public narrative doc and the app's own copy. */
const LICENSE_SCANNED = [
  'README.md',
  'SUPPORT.md',
  'CONTRIBUTING.md',
  ...readdirSync(join(REPO_ROOT, 'docs', 'public')).filter(f => f.endsWith('.md')).map(f => `docs/public/${f}`),
  ...walk(join(WEB_ROOT, 'app')).map(f => f.slice(REPO_ROOT.length + 1).replace(/\\/g, '/')),
];

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(tsx?|txt|md)$/.test(entry.name) ? [full] : [];
  });
}

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

/** Line breaks, `<br>` tags and YAML folding all count as one space; the sentence is what matters. */
function normalize(text: string): string {
  return text.replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ');
}

describe('the product describes itself with one sentence', () => {
  it.each(RESTATING_FILES)('%s restates positioning line 1 verbatim', rel => {
    expect(normalize(read(rel))).toContain(LINE_1);
  });

  it('no file still carries the retired sentence', () => {
    for (const rel of [...RESTATING_FILES, 'CLAUDE.md', 'docs/public/faq.md']) {
      expect(normalize(read(rel)), rel).not.toContain('runs the governance checks');
    }
  });
});

describe('the license is named only where a license belongs', () => {
  it.each(LICENSE_SCANNED)('%s', rel => {
    const rule = LICENSE_ALLOWED.find(entry => entry.file === rel);
    let section: string | null = null;
    const offenders: string[] = [];
    read(rel).split('\n').forEach((line, index) => {
      if (/^##\s/.test(line)) section = line.trim();
      if (!LICENSE_NAME.test(line)) return;
      if (rule?.allowed(line, section)) return;
      offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
    });
    expect(offenders, 'the license name belongs in a License section; elsewhere the words are "open source"').toEqual([]);
  });
});
