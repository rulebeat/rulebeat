/**
 * Ticket #221: an APRL rule must run its own recommendation's query. Most of the pack once carried
 * the query of the recommendation next to it, so a finding could name a problem the resource did
 * not have. Every APRL query projects the guid of the recommendation it belongs to as
 * `recommendationId`, which makes a wrong pairing visible in the committed pack.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PACK = join(process.cwd(), 'packages/web/data/packs/aprl-v2.json');
const rules = JSON.parse(readFileSync(PACK, 'utf-8')) as Array<{ id: string; name: string; rawKql?: string | null }>;

/** `recommendationId='...'` or `recommendationId="..."`, spaces around `=` allowed. */
const PROJECTED_ID = /\brecommendationId\s*=\s*(['"])([^'"]*)\1/i;

/**
 * Rules whose own upstream query projects an id that is not theirs, with the reason for each. An
 * entry here is an upstream defect that RuleBeat reproduces faithfully, not a pairing error. An
 * entry that stops being needed fails the test, so this list cannot go stale.
 */
const WRONG_UPSTREAM_ID: Record<string, string> = {
  '3c8fa7c6-6b78-a24a-a63f-348a7c71acb9':
    'The upstream query projects c8fa7c6-6b78-a24a-a63f-348a7c71acb9: the leading 3 of its own guid is missing.',
};

const projected = rules.flatMap(r => {
  const match = PROJECTED_ID.exec(r.rawKql ?? '');
  return match ? [{ rule: r, id: match[2] }] : [];
});
const mismatched = projected.filter(p => p.id.toLowerCase() !== p.rule.id.toLowerCase());

describe('the committed APRL pack', () => {
  it('has enough rules that project a recommendationId for this check to mean something', () => {
    expect(projected.length).toBeGreaterThanOrEqual(90);
  });

  it('gives every rule the query of its own recommendation', () => {
    const wrong = mismatched.filter(p => !(p.rule.id in WRONG_UPSTREAM_ID));
    expect(wrong.map(p => `${p.rule.id} (${p.rule.name}) runs the query of ${p.id}`)).toEqual([]);
  });

  it('lists in the allowlist only rules that still need it', () => {
    expect(mismatched.map(p => p.rule.id).sort()).toEqual(Object.keys(WRONG_UPSTREAM_ID).sort());
  });
});
