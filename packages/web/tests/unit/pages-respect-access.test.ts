/**
 * #275: what the Library, rule, Scans, new rule and Suppressions pages hand to their client components for a
 * person with less than Everything. Each page is called the way Next.js calls it, as a function, over the real
 * repositories and the real `requireRole` path's session lookup (only the session, `@/auth`, is mocked), and the
 * props it passes down are read from the element it returns.
 */
import { isValidElement, type ReactElement } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { replaceAssignmentsOn } from '@/lib/db/role-assignments';
import { inTransaction } from '@/lib/db/exec';
import {
  createPeople, MANAGEMENT_GROUP, MATRIX_TENANT, SCOPE_SUBSCRIPTION, SCOPED_RULE_ID, SUB_ONE, SUB_TWO, seedMatrix, seedScopedRule, type MatrixSeed,
} from '../helpers/access-matrix';
import { SCOPED_CATEGORY_REASON, SCOPED_WRITE_REASON } from '@/lib/write-controls';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));

type Props = Record<string, unknown>;

/** The first element in what a page returned whose component has this name, or undefined. */
function findElement(node: unknown, name: string): ReactElement<Props> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, name);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement(node)) return undefined;
  const element = node as ReactElement<Props>;
  if ((element.type as { name?: string }).name === name) return element;
  return findElement(element.props.children, name);
}

const propsOf = (page: unknown, name: string): Props => {
  const found = findElement(page, name);
  if (!found) throw new Error(`the page returned no ${name}`);
  return found.props;
};

describe('the pages narrow what they hand to client components', () => {
  const userIds: Record<string, string> = {};
  let seed: MatrixSeed;
  let scopedEditor: string;

  const signIn = (uid: string) => mockAuth.mockResolvedValue({ user: { uid } });
  const none = Promise.resolve({});

  beforeAll(async () => {
    await resetDb();
    Object.assign(userIds, await createPeople());
    seed = await seedMatrix();
    await seedScopedRule();
    const created = await createUser({ email: 'page-editor@example.com', role: 'editor' });
    if ('error' in created) throw new Error(created.error);
    scopedEditor = created.user.id;
    await inTransaction(tx => replaceAssignmentsOn(tx, scopedEditor, [{ tenantId: MATRIX_TENANT, scope: SCOPE_SUBSCRIPTION, role: 'editor' }]));
  });

  const scopeOf = (rules: unknown, id: string) => (rules as { id: string; scope: unknown }[]).find(r => r.id === id)?.scope;
  const HELD_ONLY = { level: 'subscription', subscriptions: [SUB_ONE], outsideAccess: 2 };
  const FULL = { level: 'subscription', subscriptions: [SUB_ONE, SUB_TWO], managementGroups: [MANAGEMENT_GROUP] };

  it('Library: sends the Viewer on one subscription no id outside it, and the controls off with no reason', async () => {
    signIn(userIds['Viewer on one subscription']!);
    const { default: LibraryPage } = await import('@/app/(app)/library/page');
    const props = propsOf(await LibraryPage({ searchParams: none }), 'LibraryClient');
    expect(scopeOf(props.initialRules, SCOPED_RULE_ID)).toEqual(HELD_ONLY);
    const text = JSON.stringify(props);
    expect(text).not.toContain(SUB_TWO);
    expect(text).not.toContain(MANAGEMENT_GROUP);
    expect(props).toMatchObject({ canAuthor: false, canDelete: false });
    expect(props.writeReason).toBeUndefined();
  });

  it('Library: sends the Editor on one subscription the controls off with the reason', async () => {
    signIn(scopedEditor);
    const { default: LibraryPage } = await import('@/app/(app)/library/page');
    const props = propsOf(await LibraryPage({ searchParams: none }), 'LibraryClient');
    expect(props).toMatchObject({ canAuthor: false, canDelete: false, writeReason: SCOPED_WRITE_REASON });
    expect(scopeOf(props.initialRules, SCOPED_RULE_ID)).toEqual(HELD_ONLY);
  });

  it('Library: sends the Editor on Everything every rule scope in full and the controls on', async () => {
    signIn(userIds['Editor on Everything']!);
    const { default: LibraryPage } = await import('@/app/(app)/library/page');
    const props = propsOf(await LibraryPage({ searchParams: none }), 'LibraryClient');
    expect(scopeOf(props.initialRules, SCOPED_RULE_ID)).toEqual(FULL);
    expect(props).toMatchObject({ canAuthor: true, canDelete: true });
    expect(props.writeReason).toBeUndefined();
  });

  it('Rule page: sends the rule with only the scope the person holds', async () => {
    signIn(userIds['Viewer on one subscription']!);
    const { default: RulePage } = await import('@/app/(app)/rules/[id]/page');
    const props = propsOf(await RulePage({ params: Promise.resolve({ id: SCOPED_RULE_ID }), searchParams: none }), 'RuleDetailClient');
    expect((props.rule as { scope: unknown }).scope).toEqual(HELD_ONLY);
    const text = JSON.stringify(props);
    expect(text).not.toContain(SUB_TWO);
    expect(text).not.toContain(MANAGEMENT_GROUP);
    expect(props.canAuthor).toBe(false);
  });

  it('Rule page: sends the Editor on one subscription canAuthor off with the reason', async () => {
    signIn(scopedEditor);
    const { default: RulePage } = await import('@/app/(app)/rules/[id]/page');
    const props = propsOf(await RulePage({ params: Promise.resolve({ id: SCOPED_RULE_ID }), searchParams: none }), 'RuleDetailClient');
    expect(props).toMatchObject({ canAuthor: false, writeReason: SCOPED_WRITE_REASON });
  });

  it('Rule page: sends the Admin the rule in full', async () => {
    signIn(userIds['Admin']!);
    const { default: RulePage } = await import('@/app/(app)/rules/[id]/page');
    const props = propsOf(await RulePage({ params: Promise.resolve({ id: SCOPED_RULE_ID }), searchParams: none }), 'RuleDetailClient');
    expect((props.rule as { scope: unknown }).scope).toEqual(FULL);
    expect(props.canAuthor).toBe(true);
  });

  it('Scans: sends the policies narrowed, the Rules tab counts inside the Scopes, and the controls off with the reason', async () => {
    signIn(scopedEditor);
    const { default: ScansPage } = await import('@/app/(app)/scans/page');
    const props = propsOf(await ScansPage({ searchParams: Promise.resolve({ tab: 'rules' }) }), 'ScansClient');
    expect(scopeOf(props.policies, SCOPED_RULE_ID)).toEqual(HELD_ONLY);
    expect(props.ruleFindingCounts).toEqual({ 'matrix-rule': 2, 'matrix-advisory-rule': 1 });
    expect(props.controls).toMatchObject({ rulesWrite: false, schedulesWrite: false, suppress: true, reason: SCOPED_WRITE_REASON });
    const text = JSON.stringify(props);
    expect(text).not.toContain(SUB_TWO);
    expect(text).not.toContain(MANAGEMENT_GROUP);
  });

  it('Scans: sends the Admin the policies and counts in full', async () => {
    signIn(userIds['Admin']!);
    const { default: ScansPage } = await import('@/app/(app)/scans/page');
    const props = propsOf(await ScansPage({ searchParams: Promise.resolve({ tab: 'rules' }) }), 'ScansClient');
    expect(scopeOf(props.policies, SCOPED_RULE_ID)).toEqual(FULL);
    expect(props.ruleFindingCounts).toEqual({ 'matrix-rule': 6, 'matrix-advisory-rule': 2 });
    expect(props.controls).toMatchObject({ rulesWrite: true, schedulesWrite: true, suppress: true });
  });

  it('Suppressions: sends only the suppressions inside the Scopes, and edit on for an Editor in one', async () => {
    const { default: SuppressionsPage } = await import('@/app/(app)/suppressions/page');
    signIn(scopedEditor);
    const inside = propsOf(await SuppressionsPage(), 'SuppressionsClient');
    expect((inside.initialSuppressions as { fingerprint: string }[]).map(s => s.fingerprint)).toEqual([seed.suppressedFingerprint]);
    expect(inside.canEdit).toBe(true);
    signIn(userIds['Viewer on one resource group']!);
    const outside = propsOf(await SuppressionsPage(), 'SuppressionsClient');
    expect(outside.initialSuppressions).toEqual([]);
    expect(outside.canEdit).toBe(false);
  });

  it('Settings: sends the category controls on for an Admin and an Editor on Everything, off with the reason for a scoped Editor, and off with none for a Viewer', async () => {
    const { default: SettingsPage } = await import('@/app/(app)/settings/page');
    const read = async (uid: string) => {
      signIn(uid);
      const props = propsOf(await SettingsPage(), 'SettingsClient');
      return { canEditCategories: props.canEditCategories, categoriesOffReason: props.categoriesOffReason };
    };
    expect(await read(userIds['Admin']!)).toEqual({ canEditCategories: true, categoriesOffReason: undefined });
    expect(await read(userIds['Editor on Everything']!)).toEqual({ canEditCategories: true, categoriesOffReason: undefined });
    expect(await read(scopedEditor)).toEqual({ canEditCategories: false, categoriesOffReason: SCOPED_CATEGORY_REASON });
    expect(await read(userIds['Viewer on one subscription']!)).toEqual({ canEditCategories: false, categoriesOffReason: undefined });
  });

  it('New rule: answers not found for the Editor on one subscription, and shows the form to the Editor on Everything', async () => {
    const { default: NewRulePage } = await import('@/app/(app)/rules/new/page');
    signIn(scopedEditor);
    await expect(NewRulePage({ searchParams: none })).rejects.toMatchObject({ digest: expect.stringContaining('404') });
    signIn(userIds['Editor on Everything']!);
    expect(findElement(await NewRulePage({ searchParams: none }), 'RuleNewClient')).toBeDefined();
  });
});
