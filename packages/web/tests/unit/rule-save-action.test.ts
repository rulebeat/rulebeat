/**
 * The edit pages draw Save in their own status bar (the form's bottom bar hides its Save when it is
 * handed saveHandleRef), so the note that posture keeps the rule's last result must sit beside that
 * Save, not in the form's bottom bar. Rendered the way the edit pages render it.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { RuleDetailClient } from '@/app/(app)/rules/[id]/rule-detail-client';
import { RuleSaveAction } from '@/components/rules/rule-save-action';
import { RULE_FORM_SAVE_NOTE } from '@/lib/widget-limits';
import type { Rule } from '@/lib/types';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, back: () => undefined, refresh: () => undefined }),
}));

const rule = {
  id: 'rule-1', name: 'Rule one', description: 'd', category: 'security', severity: 'high', enabled: true,
  type: 'custom', kind: 'state', queryBackend: 'resource-graph', scope: { level: 'subscription' },
  resourceTypes: [], conditions: [], rawKql: 'resources | where type == "microsoft.compute/virtualmachines"',
} as unknown as Rule;

const text = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node).replace(/&#x27;/g, "'");

describe('the Save area of an edit page', () => {
  it('holds Save changes and the posture note together', () => {
    const html = text(createElement(RuleSaveAction, { disabled: false, saving: false, onSave: () => undefined }));
    expect(html).toContain('Save changes');
    expect(html).toContain(RULE_FORM_SAVE_NOTE);
  });

  it('is on the rule detail page beside Save changes, for someone who can author', () => {
    const props = {
      rule, canAuthor: true, canVersion: false, personalCopyReasons: { 'resource-graph': null, 'microsoft-graph': null, 'log-analytics': null },
    } as unknown as Parameters<typeof RuleDetailClient>[0];
    const html = text(createElement(RuleDetailClient, { ...props, initialEditing: true }));
    expect(html).toContain('Save changes');
    expect(html.split(RULE_FORM_SAVE_NOTE).length - 1).toBe(1);
    // The status bar comes before the form; the form's own bottom bar (Back) comes after it.
    expect(html.indexOf(RULE_FORM_SAVE_NOTE)).toBeLessThan(html.indexOf('>Back<'));
    expect(html.indexOf('Save changes')).toBeLessThan(html.indexOf(RULE_FORM_SAVE_NOTE));
  });

  it('is not on the rule detail page for someone who cannot author', () => {
    const props = {
      rule, canAuthor: false, canVersion: false, personalCopyReasons: { 'resource-graph': null, 'microsoft-graph': null, 'log-analytics': null },
    } as unknown as Parameters<typeof RuleDetailClient>[0];
    expect(text(createElement(RuleDetailClient, props))).not.toContain(RULE_FORM_SAVE_NOTE);
  });
});
