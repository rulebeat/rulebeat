/**
 * Full-pack two-cycle round-trip sweep.
 *
 * docs/engineering/conventions/kql.md requires sweeping `data/packs/aprl-v2.json` for drift across two cycles
 * before trusting a parser change — a change verified only against hand-picked cases can still corrupt
 * a shape none of those cases happened to cover. This sweeps every rule in the real, committed pack:
 * parse -> regenerate -> reparse -> regenerate, asserting the second regeneration matches the first
 * (a parse/regenerate cycle that keeps rewriting its own output on every pass is corrupting the rule a
 * little more each time it's opened for editing, even if no single cycle looks wrong).
 *
 * A handful of pack entries carry `rawKql: "// cannot-be-validated-with-arg"` — a placeholder, not
 * real KQL — which parses to an empty query with no assertion of interest; those are only checked for
 * not throwing, not for stability, since there is no real pipeline to keep stable.
 *
 * Spec 027: the placeholder predicate used to be `startsWith('//')`, which misclassified every real
 * rule as a placeholder too — virtually all of them open with a `// Azure Resource Graph Query`
 * header comment. That silently skipped stability checking for 120 of 143 real rules. The predicate
 * now matches only the literal placeholder string, and a paren-balance assertion was added alongside
 * the stability check — a regenerated query with an unmatched paren is not valid Kusto even when it
 * happens to be a fixed point under repeated regeneration (RB-QA-008b was exactly this shape).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildQueryFromVisual, parseKqlToVisualQuery, DEFAULT_PROJECT_COLUMNS } from '@/lib/kql';

const WEB_ROOT = resolve(__dirname, '..', '..');
const PACK_PATH = join(WEB_ROOT, 'data', 'packs', 'aprl-v2.json');

interface PackRule {
  id: string;
  name: string;
  rawKql?: string;
}

function regenerateOnce(kql: string): string {
  const parsed = parseKqlToVisualQuery(kql);
  return buildQueryFromVisual(parsed.visualQuery, {
    scope: parsed.scope,
    resourceTypes: parsed.resourceTypes.length ? parsed.resourceTypes : ['*'],
    projectColumns: parsed.projectColumns.length ? parsed.projectColumns : DEFAULT_PROJECT_COLUMNS,
  });
}

describe('spec 016 · aprl-v2.json survives two parse/regenerate cycles unchanged', () => {
  const rules = (JSON.parse(readFileSync(PACK_PATH, 'utf-8')) as PackRule[])
    .filter(r => typeof r.rawKql === 'string' && r.rawKql.trim().length > 0);

  it('the pack has real rules to sweep', async () => {
    expect(rules.length).toBeGreaterThan(100);
  });

  const PLACEHOLDER = '// cannot-be-validated-with-arg';
  const real = rules.filter(r => r.rawKql!.trim() !== PLACEHOLDER);
  const placeholders = rules.filter(r => r.rawKql!.trim() === PLACEHOLDER);

  it('the real/placeholder split actually covers the pack', async () => {
    // Guards against the predicate regressing back to matching every commented rule (spec 027).
    expect(real.length).toBeGreaterThan(100);
  });

  it.each(real.map(r => [r.id, r.name, r.rawKql!] as const))(
    'regenerating twice produces identical, paren-balanced KQL — %s %s',
    (_id, _name, rawKql) => {
      const first = regenerateOnce(rawKql);
      const opens = (first.match(/\(/g) ?? []).length;
      const closes = (first.match(/\)/g) ?? []).length;
      expect(opens, 'regenerated KQL must have balanced parens').toBe(closes);

      const second = regenerateOnce(first);
      expect(second).toBe(first);
    },
  );

  it.each(placeholders.map(r => [r.id, r.name, r.rawKql!] as const))(
    'placeholder rawKql does not throw — %s %s',
    (_id, _name, rawKql) => {
      expect(() => regenerateOnce(rawKql)).not.toThrow();
    },
  );
});
