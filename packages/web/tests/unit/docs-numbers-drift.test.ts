/**
 * Architecture test: every number the public docs state about the product matches the code.
 *
 * The README said "156 checks out of the box, 13 written by us, enables 10" while the code shipped
 * 158 / 15 / 12; nothing failed, the numbers just rotted. Prose regexes are the wrong guard (a copy
 * edit silently de-registers them), so the convention is an invisible HTML comment placed right
 * before the number in the doc: `<!-- count:checks-total -->158 checks`, `<!-- count:roles -->Three
 * roles`. This test scans README.md and every docs/public/*.md, resolves the token after each
 * marker (digits or a number word), and compares it with a count derived live from the code. It
 * also requires a minimum set of markers to be present, so deleting a marker is not a way to pass.
 *
 * It deliberately does not check sentences without a marker: if a doc states a product number,
 * put a marker on it. Fix the doc, not this test.
 *
 * `NotificationChannelType` is a type-only union with no runtime array, so that count is read
 * from source with a regex; exporting a runtime array later would let this test import it instead.
 * Widget types are counted from the Add Widget catalog (`WIDGET_TEMPLATES` in
 * `components/dashboard/add-widget-panel.tsx`), not from the `WidgetType` union: the union can
 * carry a member that is typed before its widget ships, and the docs describe what a user can add.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GRAPH_RESOURCE_PATHS } from '@rulebeat/core';
import { BUILTIN_RULES } from '@/lib/builtin-rules';
import { ROLES } from '@/lib/rbac';

// Resolved from this file's own location, not `process.cwd()` — the working directory differs
// between a whole-repo test run and a single-package one.
const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_ROOT = join(WEB_ROOT, '..', '..');

// ---- Live counts -------------------------------------------------------------------------------

interface PackRule { enabled?: boolean }
const PACKS_DIR = join(WEB_ROOT, 'data', 'packs');
const packManifest = JSON.parse(readFileSync(join(PACKS_DIR, 'pack-manifest.json'), 'utf8')) as Record<string, { policyCount?: number }>;
const packFiles = readdirSync(PACKS_DIR).filter(f => f.endsWith('.json') && f !== 'pack-manifest.json');
const packRules = new Map<string, PackRule[]>(
  packFiles.map(f => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(PACKS_DIR, f), 'utf8')) as PackRule[]]),
);

function countUnionMembers(file: string, typeName: string): number {
  const src = readFileSync(file, 'utf8');
  const m = src.match(new RegExp(`export type ${typeName} =([^;]+);`));
  if (!m) throw new Error(`could not find 'export type ${typeName}' in ${file}`);
  const body = m[1]!.replace(/\/\/[^\n]*/g, ''); // drop line comments inside the union
  return (body.match(/'[A-Za-z-]+'/g) ?? []).length;
}

const CORE_ENGINE_TYPES = join(REPO_ROOT, 'packages', 'core', 'src', 'engine', 'types.ts');

/** Widget types a user can add from the Add Widget panel: one `type: '...'` entry per catalog item. */
function countWidgetTemplates(): number {
  const src = readFileSync(join(WEB_ROOT, 'components', 'dashboard', 'add-widget-panel.tsx'), 'utf8');
  const m = src.match(/const WIDGET_TEMPLATES: WidgetTemplate\[\] = \[([\s\S]*?)\n\];/);
  if (!m) throw new Error('could not find WIDGET_TEMPLATES in add-widget-panel.tsx');
  return (m[1]!.match(/^\s*type: '[a-z-]+',$/gm) ?? []).length;
}

/** Onboarding wizard steps: one `{ id: N, ... }` entry per step in the stepper's STEPS array. */
function countOnboardingSteps(): number {
  const src = readFileSync(join(WEB_ROOT, 'app', 'onboarding', 'onboarding-client.tsx'), 'utf8');
  const m = src.match(/const STEPS: StepperStep\[\] = \[([\s\S]*?)\n\];/);
  if (!m) throw new Error('could not find STEPS in onboarding-client.tsx');
  return (m[1]!.match(/\{ id: \d+,/g) ?? []).length;
}

const allPackRules = [...packRules.values()].flat();
const liveCounts: Record<string, number> = {
  'builtin-rules': BUILTIN_RULES.length,
  'enabled-default': BUILTIN_RULES.filter(r => r.enabled).length + allPackRules.filter(r => r.enabled).length,
  'checks-total': BUILTIN_RULES.length + allPackRules.length,
  'credential-expiry-rules': BUILTIN_RULES.filter(r => r.queryBackend === 'microsoft-graph').length,
  'widget-types': countWidgetTemplates(),
  'onboarding-steps': countOnboardingSteps(),
  'channel-types': countUnionMembers(join(WEB_ROOT, 'lib', 'db', 'notification-channels.ts'), 'NotificationChannelType'),
  'roles': ROLES.length,
  'graph-resource-types': GRAPH_RESOURCE_PATHS.length,
  // The builder's operator dropdown: every VisualFilterOperator except the parser-only 'raw'.
  'visual-operators': countUnionMembers(CORE_ENGINE_TYPES, 'VisualFilterOperator') - 1,
};
for (const [id, rules] of packRules) liveCounts[`pack-rules:${id}`] = rules.length;

// ---- Markers in the docs -----------------------------------------------------------------------

const DOC_FILES = [
  join(REPO_ROOT, 'README.md'),
  ...readdirSync(join(REPO_ROOT, 'docs', 'public')).filter(f => f.endsWith('.md')).map(f => join(REPO_ROOT, 'docs', 'public', f)),
];

// `<!-- count:KEY -->`, optionally followed by markdown emphasis/backticks, then the number token.
const MARKER = /<!--\s*count:([a-z0-9:-]+)\s*-->[\s*_`]*([0-9]+|[A-Za-z]+)/g;

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
};

function resolveToken(token: string): number | undefined {
  if (/^[0-9]+$/.test(token)) return Number(token);
  return NUMBER_WORDS[token.toLowerCase()];
}

interface Occurrence { file: string; key: string; token: string }
const occurrences: Occurrence[] = DOC_FILES.flatMap(file => {
  const rel = file.slice(REPO_ROOT.length + 1).replace(/\\/g, '/');
  return [...readFileSync(file, 'utf8').matchAll(MARKER)].map(m => ({ file: rel, key: m[1]!, token: m[2]! }));
});

// A marker that must exist in a given doc, so it cannot be deleted to make the test pass.
const REQUIRED: Array<[file: string, key: string]> = [
  ['README.md', 'checks-total'],
  ['README.md', 'builtin-rules'],
  ['README.md', 'pack-rules:aprl-v2'],
  ['README.md', 'enabled-default'],
  ['README.md', 'widget-types'],
  ['README.md', 'roles'],
  ['docs/public/authoring-rules.md', 'graph-resource-types'],
  ['docs/public/authoring-rules.md', 'pack-rules:aprl-v2'],
  ['docs/public/authoring-rules.md', 'credential-expiry-rules'],
  ['docs/public/authoring-rules.md', 'visual-operators'],
  ['docs/public/security.md', 'graph-resource-types'],
  ['docs/public/security.md', 'credential-expiry-rules'],
  ['docs/public/rbac.md', 'roles'],
  ['docs/public/install.md', 'onboarding-steps'],
];

describe('public docs state the same numbers the code ships', () => {
  it('found count markers at all (guards against this suite silently testing nothing)', async () => {
    expect(occurrences.length).toBeGreaterThan(8);
  });

  it('derived live counts look sane (guards against a broken source read)', async () => {
    expect(liveCounts['builtin-rules']).toBeGreaterThan(5);
    expect(liveCounts['widget-types']).toBeGreaterThan(5);
    expect(liveCounts['pack-rules:aprl-v2']).toBeGreaterThan(100);
    expect(liveCounts['roles']).toBe(3);
    expect(liveCounts['visual-operators']).toBeGreaterThan(20);
  });

  it('every marker names a key this test knows how to derive', async () => {
    const unknown = occurrences.filter(o => !(o.key in liveCounts)).map(o => `${o.file}: count:${o.key}`);
    expect(unknown, [
      'These docs carry a <!-- count:KEY --> marker with a key this test cannot derive. Either the',
      `key is a typo or the test needs a new derivation. Known keys: ${Object.keys(liveCounts).join(', ')}.`,
    ].join(' ')).toEqual([]);
  });

  it('every marker is followed by a number this test can read', async () => {
    const unreadable = occurrences.filter(o => resolveToken(o.token) === undefined).map(o => `${o.file}: count:${o.key} -> "${o.token}"`);
    expect(unreadable, 'A count marker must sit directly before digits or a number word (zero..twenty).').toEqual([]);
  });

  it.each(REQUIRED)('%s still carries the count:%s marker', (file, key) => {
    const present = occurrences.some(o => o.file === file && o.key === key);
    expect(present, [
      `${file} used to state this number with a <!-- count:${key} --> marker and no longer does.`,
      'If the sentence moved, move the marker with it; if the number is genuinely no longer stated,',
      'remove it from REQUIRED in this test deliberately.',
    ].join(' ')).toBe(true);
  });

  it.each(occurrences.map(o => [o.file, o.key, o.token] as const))('%s: count:%s says %s, which must equal the code', (file, key, token) => {
    const stated = resolveToken(token);
    const live = liveCounts[key];
    expect(stated, [
      `${file} states ${token} for ${key} but the code has ${live}.`,
      'Update the doc (or its marker key), not this test.',
    ].join(' ')).toBe(live);
  });

  it('pack rule counts agree with pack-manifest.json policyCount', async () => {
    for (const [id, rules] of packRules) {
      expect(packManifest[id]?.policyCount, `pack-manifest.json policyCount for ${id}`).toBe(rules.length);
    }
  });
});

// ---- Pinned image tags ---------------------------------------------------------------------------
// The docs pin the image to the exact current version, never `:latest` (reversed 2026-08-26,
// reversing the 0.2.4 switch to `:latest`). The 0.2.4-era worry was staleness: 0.1.0 survived the
// 0.2.0 release in nine places. scripts/release.mjs's pinImageTags() now rewrites every image
// reference inside the same release commit that bumps package.json, so a stale pin cannot ship,
// and this test is the proof: any doc referencing `:latest`, or a version other than
// package.json's, fails here. Pinning is back because a copied install command should be
// reproducible and should match what the website's Install page renders from the release data.
// Image tags carry no `v` prefix (publish-image.yml derives them as `${GITHUB_REF_NAME#v}`), so
// the expected form is `:0.2.4`, not `:v0.2.4`.

const IMAGE_REF = /ghcr\.io\/rulebeat\/rulebeat:(?:latest|v?\d+\.\d+\.\d+)/g;
const APP_VERSION = (JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version;

describe('docs pin the image to the current version, never :latest', () => {
  it.each(DOC_FILES.map(file => [file.slice(REPO_ROOT.length + 1).replace(/\\/g, '/'), file] as const))('%s pins every image reference to the current version', (rel, file) => {
    const refs = [...readFileSync(file, 'utf8').matchAll(IMAGE_REF)].map(m => m[0]);
    const wrong = refs.filter(ref => ref !== `ghcr.io/rulebeat/rulebeat:${APP_VERSION}`);
    expect(wrong, [
      `${rel} references ${wrong.join(', ')} but the current version is ${APP_VERSION}.`,
      'Docs pin the exact release tag; scripts/release.mjs rewrites them on every release.',
      'Use the current version tag, or name a version in prose without the image path.',
    ].join(' ')).toEqual([]);
  });
});
