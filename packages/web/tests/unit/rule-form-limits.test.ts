/**
 * The rule form states two limits on posture: a severity change reaches open findings on the next scan
 * (under the Severity field), and, on edit only, posture keeps the rule's last result until it next runs
 * (in the Save area). Rendered on the server.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { RuleForm } from '@/components/rules/rule-form';
import { RULE_FORM_SAVE_NOTE, RULE_FORM_SEVERITY_HELP } from '@/lib/widget-limits';
import type { Rule } from '@/lib/types';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, back: () => undefined, refresh: () => undefined }),
}));

const rule = {
  id: 'rule-1', name: 'Rule one', description: 'd', category: 'security', severity: 'high', enabled: true,
  type: 'custom', kind: 'state', queryBackend: 'resource-graph', scope: { level: 'subscription' },
  resourceTypes: [], conditions: [], rawKql: 'resources | where type == "microsoft.compute/virtualmachines"',
} as unknown as Rule;

const render = (initial?: Rule, extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(RuleForm, { initial, canAuthor: true, ...extra }))
  .replace(/&#x27;/g, "'");

describe('the rule form', () => {
  it('says under Severity that a change reaches open findings on the next scan, on a new rule and an edit alike', () => {
    expect(render(rule)).toContain(RULE_FORM_SEVERITY_HELP);
    expect(render(undefined)).toContain(RULE_FORM_SEVERITY_HELP);
  });

  it('says in the Save area that posture keeps the last result until the rule next runs, on edit only', () => {
    expect(render(rule)).toContain(RULE_FORM_SAVE_NOTE);
    expect(render(undefined)).not.toContain(RULE_FORM_SAVE_NOTE);
    expect(render({ ...rule, id: '' })).not.toContain(RULE_FORM_SAVE_NOTE);
  });

  it('leaves the note to the embedding page when that page draws Save itself', () => {
    const saveHandleRef = { current: null as (() => void) | null };
    expect(render(rule, { saveHandleRef })).not.toContain(RULE_FORM_SAVE_NOTE);
  });
});
