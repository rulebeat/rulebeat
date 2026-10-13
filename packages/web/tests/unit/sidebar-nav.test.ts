/** Who sees which sidebar entries. Hiding an entry is presentation only; the pages and routes gate themselves. */
import { describe, expect, it } from 'vitest';
import { navForRole } from '@/components/layout/sidebar';
import { ROLES } from '@/lib/rbac';

const hrefs = (role: (typeof ROLES)[number]) => navForRole(role).bottom.map(item => item.href);

describe('the sidebar nav by role', () => {
  it('puts Access immediately before the Audit log for an admin', () => {
    const list = hrefs('admin');
    expect(list).toContain('/access');
    expect(list.indexOf('/access')).toBe(list.indexOf('/audit') - 1);
  });

  it.each(ROLES)('shows the Access entry to a %s: a person who manages no one reads their own access there', (role) => {
    const list = hrefs(role);
    expect(list).toContain('/access');
    expect(list.indexOf('/access')).toBe(list.indexOf('/settings') + 1);
    expect(navForRole(role).top.map(item => item.href)).not.toContain('/access');
  });

  it.each(['viewer', 'editor'] as const)('still hides the Audit log from a %s', (role) => {
    expect(hrefs(role)).not.toContain('/audit');
  });

  it('labels the entry Access', () => {
    expect(navForRole('admin').bottom.find(item => item.href === '/access')?.label).toBe('Access');
  });
});
