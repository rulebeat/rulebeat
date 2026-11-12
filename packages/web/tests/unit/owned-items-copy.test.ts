import { describe, expect, it } from 'vitest';
import { ownedItemsAuditSentence, ownedItemsSentence } from '@/lib/owned-items-copy';

const none = { deletedDashboards: 0, deletedViews: 0, releasedDashboards: 0, releasedViews: 0 };

describe('ownedItemsSentence', () => {
  it('says nothing for a person who owns nothing', () => {
    expect(ownedItemsSentence(none)).toBe('');
    expect(ownedItemsAuditSentence(none)).toBe('');
  });

  it('counts what is deleted and what stays Shared, with the right plurals', () => {
    expect(ownedItemsSentence({ deletedDashboards: 2, deletedViews: 1, releasedDashboards: 1, releasedViews: 3 }))
      .toBe('2 Personal dashboards and 1 Personal saved view will be deleted. 1 Shared dashboard and 3 Shared saved views will stay Shared with no owner.');
  });

  it('leaves out a part that is zero', () => {
    expect(ownedItemsSentence({ ...none, deletedViews: 4 })).toBe('4 Personal saved views will be deleted.');
    expect(ownedItemsSentence({ ...none, releasedDashboards: 1 })).toBe('1 Shared dashboard will stay Shared with no owner.');
  });

  it('writes the audit entry in the past tense', () => {
    expect(ownedItemsAuditSentence({ deletedDashboards: 2, deletedViews: 0, releasedDashboards: 0, releasedViews: 1 }))
      .toBe('2 Personal dashboards deleted. 1 Shared saved view left Shared with no owner.');
  });
});
