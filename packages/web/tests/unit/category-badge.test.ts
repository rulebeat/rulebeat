/**
 * Spec 033(d) — Recent Findings must render a finding's category through CategoryBadge (real
 * label, colored swatch), not the raw category id string. No React component-rendering test layer
 * exists in this codebase (see tests/unit/toggle-set.test.ts), so CategoryBadge is called directly
 * as a plain function — it has zero hooks, so nothing here needs React's renderer — and the
 * returned element tree is inspected directly.
 */
import { describe, expect, it } from 'vitest';
import { CategoryBadge } from '@/components/findings/category-badge';

describe('CategoryBadge (spec 033)', () => {
  it('renders the category label and a colour swatch when the category is known', async () => {
    const el = CategoryBadge({
      id: 'security',
      categories: [{ id: 'security', label: 'Security', color: '#10b981' }],
    });

    const [swatch, label] = el.props.children;
    expect(label).toBe('Security');
    expect(swatch).toBeTruthy();
    expect(swatch.props.style.backgroundColor).toBe('#10b981');
  });

  it('falls back to the raw id with no swatch when the category list has not loaded yet', async () => {
    // Recent Findings fetches /api/widgets/filter-options client-side; categories is [] until it
    // resolves. Must degrade to the id, not crash or show nothing, during that window.
    const el = CategoryBadge({ id: 'security', categories: [] });

    const [swatch, label] = el.props.children;
    expect(label).toBe('security');
    expect(swatch).toBeFalsy();
  });
});
