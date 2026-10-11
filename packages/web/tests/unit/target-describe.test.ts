import { describe, expect, it } from 'vitest';
import { describeTarget } from '@/lib/target-describe';

describe('describeTarget', () => {
  it('shows a plain hyphen for a target with no values', () => {
    expect(describeTarget({ targetType: 'categories', targetValues: [] }, new Map(), new Map())).toBe('-');
  });

  it('describes an all-categories target without looking at its values', () => {
    expect(describeTarget({ targetType: 'all', targetValues: [] }, new Map(), new Map())).toBe('All categories');
  });
});
