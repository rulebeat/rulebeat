/**
 * B3 phase 3 · setRulesEnabled / PATCH /api/rules/bulk
 *
 * The bulk toggle exists specifically so onboarding step 3 can flip many rules without round-tripping
 * every row through `await saveRules()` (delete + full reinsert) — that path is how a field eventually gets
 * silently dropped when 156 rows get rebuilt to flip 143 booleans. This suite asserts the promise
 * directly: every field except `enabled` survives byte-identical.
 */
import { describe, expect, it } from 'vitest';
import { loadRules, setRulesEnabled } from '@/lib/rules';

describe('B3 · setRulesEnabled', () => {
  it('flips only enabled, leaving every other field byte-identical', async () => {
    const before = await loadRules();
    // Prefer an aprl-v2 rule (real committed KQL, closest to what onboarding step 3 actually
    // flips) but fall back to any seeded rule — whether the pack is seeded into the live test db
    // depends on the working directory `lib/db/client.ts` was imported under (see its DATA_DIR
    // comment), which this suite doesn't control.
    const target = before.find(r => r.pack === 'aprl-v2') ?? before[0];
    expect(target, 'expected at least one rule to be seeded').toBeDefined();

    const wasEnabled = target!.enabled;
    try {
      const { updatedIds, notFoundIds } = await setRulesEnabled([target!.id], !wasEnabled);
      expect(updatedIds).toEqual([target!.id]);
      expect(notFoundIds).toEqual([]);

      const after = (await loadRules()).find(r => r.id === target!.id)!;
      expect(after.enabled).toBe(!wasEnabled);
      expect(after.name).toBe(target!.name);
      expect(after.description).toBe(target!.description);
      expect(after.category).toBe(target!.category);
      expect(after.severity).toBe(target!.severity);
      expect(after.rawKql).toBe(target!.rawKql);
      expect(after.conditions).toEqual(target!.conditions);
      expect(after.conditionGroups).toEqual(target!.conditionGroups);
      expect(after.tags).toEqual(target!.tags);
      expect(after.scope).toEqual(target!.scope);
      expect(after.resourceTypes).toEqual(target!.resourceTypes);
    } finally {
      await setRulesEnabled([target!.id], wasEnabled); // restore — this suite shares the live test db
    }
  });

  it('reports unknown ids in notFoundIds without touching real ones', async () => {
    const real = (await loadRules())[0]!;
    const fakeId = 'not-a-real-rule-id';

    const { updatedIds, notFoundIds } = await setRulesEnabled([real.id, fakeId], real.enabled);
    expect(updatedIds).toEqual([real.id]);
    expect(notFoundIds).toEqual([fakeId]);
  });

  it('an empty id list is a no-op', async () => {
    const { updatedIds, notFoundIds } = await setRulesEnabled([], true);
    expect(updatedIds).toEqual([]);
    expect(notFoundIds).toEqual([]);
  });

  it('all-unknown ids come back entirely in notFoundIds', async () => {
    const { updatedIds, notFoundIds } = await setRulesEnabled(['nope-1', 'nope-2'], true);
    expect(updatedIds).toEqual([]);
    expect(notFoundIds.sort()).toEqual(['nope-1', 'nope-2']);
  });
});
