/**
 * Ticket #222: the APRL pack must not ship a rule whose query is only an upstream placeholder
 * comment such as `// under-development`. Such a rule can never pass or find anything, so the
 * Library would list a check that does not check.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isCommentOnlyQuery } from '@/lib/aprl-pairing';

const PACK = join(process.cwd(), 'packages/web/data/packs/aprl-v2.json');
const rules = JSON.parse(readFileSync(PACK, 'utf-8')) as Array<{ id: string; name: string; rawKql?: string | null }>;

describe('the committed APRL pack', () => {
  it('is large enough for the placeholder sweep to mean something', () => {
    expect(rules.length).toBeGreaterThan(100);
  });

  it('ships no rule whose query is only comments and whitespace', () => {
    const placeholders = rules.filter(r => isCommentOnlyQuery(r.rawKql ?? ''));
    expect(placeholders.map(r => `${r.id} (${r.name})`)).toEqual([]);
  });
});
