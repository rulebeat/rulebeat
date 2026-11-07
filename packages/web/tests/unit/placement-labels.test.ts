/**
 * Every FindingPlacement has a name on screen. `PLACEMENT_LABEL` is typed `Record<FindingPlacement, string>`,
 * so the type check fails for a placement added without a label; this test holds the words themselves.
 */
import { describe, expect, it } from 'vitest';
import { DIRECTORY_LABEL, FINDING_PLACEMENTS, PLACEMENT_LABEL, placementValueLabel } from '@/lib/placement';

describe('placement labels', () => {
  it('names each placement the way a person says it', () => {
    expect(PLACEMENT_LABEL).toEqual({
      resource: 'Resource', subscription: 'Subscription', 'management-group': 'Management group',
      directory: 'Directory', workspace: 'Workspace', unplaceable: 'Not placed',
    });
    expect(PLACEMENT_LABEL.directory).toBe(DIRECTORY_LABEL);
  });

  it('has a label for every placement and no raw key shown', () => {
    for (const placement of FINDING_PLACEMENTS) expect(placementValueLabel(placement)).toBe(PLACEMENT_LABEL[placement]);
  });

  it('shows an unknown value as it is stored', () => {
    expect(placementValueLabel('somewhere-new')).toBe('somewhere-new');
  });
});
