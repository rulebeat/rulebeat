/**
 * #275: which write controls a person gets, and the reason when a control they might expect is off. The reason
 * is set only when a Role the person holds allows the action but none of those Roles is held on Everything.
 */
import { describe, expect, it } from 'vitest';
import { buildAccess, everythingAccess, NO_ACCESS, parseScope, type Access } from '@/lib/access-model';
import { accessAllowing, type Role } from '@/lib/rbac';
import { categoryControlFor, SCOPED_CATEGORY_REASON, SCOPED_WRITE_REASON, writeControlsFor } from '@/lib/write-controls';

const grants = (...held: [path: string, role: Role][]): Access =>
  buildAccess(held.map(([path, role]) => ({ tenantId: 't', scope: parseScope(path)!, role })), 'manual');

const SUB = '/subscriptions/00000000-0000-0000-0000-00000000000a';
const SUB_TWO = '/subscriptions/00000000-0000-0000-0000-00000000000b';

const ALL_ON = { rulesWrite: true, rulesDelete: true, schedulesWrite: true, suppress: true };
const ALL_OFF = { rulesWrite: false, rulesDelete: false, schedulesWrite: false, suppress: false };

describe('writeControlsFor', () => {
  it('gives an Admin every control and no reason', () => {
    expect(writeControlsFor(everythingAccess('admin'))).toEqual(ALL_ON);
  });

  it('gives an Editor on Everything every control and no reason', () => {
    expect(writeControlsFor(everythingAccess('editor', 'manual'))).toEqual(ALL_ON);
  });

  it('turns the library and schedule controls off for an Editor on one subscription, with the reason, and leaves suppressing on', () => {
    expect(writeControlsFor(grants([SUB, 'editor']))).toEqual({
      rulesWrite: false, rulesDelete: false, schedulesWrite: false, suppress: true, reason: SCOPED_WRITE_REASON,
    });
  });

  it('says an Admin or an Editor on Everything is needed, without an em dash', () => {
    expect(SCOPED_WRITE_REASON).toContain('Admin');
    expect(SCOPED_WRITE_REASON).toContain('Editor on Everything');
    expect(SCOPED_WRITE_REASON).not.toContain(String.fromCharCode(0x2014));
  });

  it('gives a Viewer on one subscription no control and no reason, as a Viewer has today', () => {
    expect(writeControlsFor(grants([SUB, 'viewer']))).toEqual(ALL_OFF);
  });

  it('gives a Viewer on Everything no control and no reason', () => {
    expect(writeControlsFor(everythingAccess('viewer', 'manual'))).toEqual(ALL_OFF);
  });

  it('gives a person who is an Editor on one Scope and a Viewer on another the reason, since a Role they hold allows the write', () => {
    expect(writeControlsFor(grants([SUB, 'editor'], [SUB_TWO, 'viewer'])).reason).toBe(SCOPED_WRITE_REASON);
  });

  it('gives an Editor on a Scope who is a Viewer on Everything the reason: the Editor Role is not held on Everything', () => {
    const controls = writeControlsFor(grants(['/', 'viewer'], [SUB, 'editor']));
    expect(controls.rulesWrite).toBe(false);
    expect(controls.reason).toBe(SCOPED_WRITE_REASON);
  });

  it('gives a person with no Scope nothing, and no reason', () => {
    expect(writeControlsFor(NO_ACCESS)).toEqual(ALL_OFF);
  });
});

describe('categoryControlFor', () => {
  it('allows an Admin and an Editor on Everything, with no reason', () => {
    expect(categoryControlFor(everythingAccess('admin'))).toEqual({ allowed: true });
    expect(categoryControlFor(everythingAccess('editor', 'manual'))).toEqual({ allowed: true });
  });

  it('turns the controls off for an Editor on one subscription, with the reason', () => {
    expect(categoryControlFor(grants([SUB, 'editor']))).toEqual({ allowed: false, reason: SCOPED_CATEGORY_REASON });
    expect(categoryControlFor(grants([SUB, 'editor'], [SUB_TWO, 'viewer'])).reason).toBe(SCOPED_CATEGORY_REASON);
  });

  it('gives a Viewer, on Everything or a subscription, and a person with no Scope, no reason', () => {
    expect(categoryControlFor(everythingAccess('viewer', 'manual'))).toEqual({ allowed: false });
    expect(categoryControlFor(grants([SUB, 'viewer']))).toEqual({ allowed: false });
    expect(categoryControlFor(NO_ACCESS)).toEqual({ allowed: false });
  });

  it('says an Admin or an Editor on Everything is needed', () => {
    expect(SCOPED_CATEGORY_REASON).toContain('categories');
    expect(SCOPED_CATEGORY_REASON).toContain('Admin');
    expect(SCOPED_CATEGORY_REASON).toContain('Editor on Everything');
  });
});

describe('accessAllowing', () => {
  it('keeps only the grants whose Role allows the action', () => {
    const kept = accessAllowing(grants([SUB, 'editor'], [SUB_TWO, 'viewer']), 'suppressions:write');
    expect(kept.grants.map(g => g.scope.path)).toEqual([SUB]);
  });

  it('is Everything only when the Role held on Everything allows the action', () => {
    expect(accessAllowing(everythingAccess('editor', 'manual'), 'suppressions:write').everything).toBe(true);
    expect(accessAllowing(everythingAccess('viewer', 'manual'), 'suppressions:write').everything).toBe(false);
    expect(accessAllowing(grants(['/', 'viewer'], [SUB, 'editor']), 'suppressions:write').everything).toBe(false);
  });

  it('keeps the management group expansion only for the grants whose Role allows the action', () => {
    const mg = '/providers/Microsoft.Management/managementGroups/mg-example';
    const expansion = (role: Role) => ({ tenantId: 't', path: mg, role, groups: ['mg-example'], subscriptions: ['s1'] });
    const editorGroup = buildAccess([{ tenantId: 't', scope: parseScope(mg)!, role: 'editor' }], 'manual', [expansion('editor')]);
    expect(accessAllowing(editorGroup, 'suppressions:write').managementGroups).toEqual([expansion('editor')]);
    const viewerGroup = buildAccess([{ tenantId: 't', scope: parseScope(mg)!, role: 'viewer' }], 'manual', [expansion('viewer')]);
    expect(accessAllowing(viewerGroup, 'suppressions:write').managementGroups).toEqual([]);
  });

  it('leaves nothing when no Role held allows the action', () => {
    const none = accessAllowing(grants([SUB, 'viewer']), 'suppressions:write');
    expect(none.grants).toEqual([]);
    expect(none.everything).toBe(false);
  });
});
