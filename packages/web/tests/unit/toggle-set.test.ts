/**
 * Spec 018 (RB-QA-020) · the category tab strip's click handler is exactly
 * `setCategoryFilter(prev => toggleInSet(prev, cat.id))` — same building block severity's
 * segmented control already uses. This codebase has no React component-rendering test layer
 * (Vitest runs `environment: 'node'`, no @testing-library/react), so the multi-select tab-strip
 * interaction contract — clicking two tabs keeps both active, clicking an active one again removes
 * just that one — is verified at this shared primitive rather than by rendering the component.
 */
import { describe, expect, it } from 'vitest';
import { toggleInSet } from '@/lib/toggle-set';

describe('toggleInSet · category tab strip multi-select contract', () => {
  it('clicking an unselected category tab adds it without touching the others', async () => {
    const afterFirst = toggleInSet(new Set<string>(), 'security');
    const afterSecond = toggleInSet(afterFirst, 'cost');
    expect(afterSecond).toEqual(new Set(['security', 'cost']));
  });

  it('clicking an already-active category tab removes just that one, not the whole selection', async () => {
    const selected = new Set(['security', 'cost', 'identity']);
    const result = toggleInSet(selected, 'cost');
    expect(result).toEqual(new Set(['security', 'identity']));
  });

  it('never mutates the input set', async () => {
    const selected = new Set(['security']);
    toggleInSet(selected, 'cost');
    expect(selected).toEqual(new Set(['security']));
  });
});
