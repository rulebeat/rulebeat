/**
 * Issue #180: what a channel is sent. Advisories sit in their own labelled "Advisories" section,
 * separate from problems, in every format the dispatcher supports. A message with no Advisories is
 * exactly what it was before the setting existed (the literals below are the pre-#180 output), and a
 * message holding only Advisories is allowed.
 */
import { describe, expect, it } from 'vitest';
import type { Finding, Severity } from '@/lib/types';
import type { ScheduleRun } from '@/lib/schedule-runs';
import { buildPayload } from '@/lib/notifications/format';

const HREF = 'https://rulebeat.example/scans?tab=results&status=new';
const ADVISORIES_HREF = 'https://rulebeat.example/scans?tab=advisories&status=new';

const RUN = {
  id: 'run-1', scheduleId: 'sched-1', triggeredBy: 'schedule',
} as ScheduleRun;

function finding(title: string, resourceName: string, severity: Severity, kind: 'state' | 'advisory'): Finding {
  return {
    module: 'test', ruleId: `rule-${title}`, fingerprint: `fp-${title}`, severity, category: 'reliability', kind,
    resourceId: `/subscriptions/s/resourceGroups/rg/providers/p/t/${resourceName}`, resourceType: 'p/t', resourceName,
    subscriptionId: 'sub-1', resourceGroup: 'rg', location: 'eastus', title, description: '', recommendation: '',
    remediationSteps: [], evidence: {}, detectedAt: '2026-10-08T00:00:00.000Z',
  } as Finding;
}

const PROBLEMS = [finding('Public storage', 'st-1', 'high', 'state')];
const ADVISORIES = [
  finding('VM size retiring', 'vm-1', 'medium', 'advisory'),
  finding('VM size retiring', 'vm-2', 'low', 'advisory'),
];

function email(problems: Finding[], advisories?: Finding[]) {
  const p = buildPayload('email', problems, HREF, RUN, advisories, ADVISORIES_HREF);
  if (p.kind !== 'email') throw new Error('expected an email payload');
  return { subject: p.subject, text: p.text };
}

function webhookBody(type: 'webhook' | 'teams' | 'slack', problems: Finding[], advisories?: Finding[]) {
  const p = buildPayload(type, problems, HREF, RUN, advisories, ADVISORIES_HREF);
  if (p.kind !== 'webhook') throw new Error('expected a webhook payload');
  return p.body as Record<string, unknown>;
}

/** Every string anywhere in a JSON-shaped payload, in document order. */
function texts(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(texts);
  if (node && typeof node === 'object') return Object.values(node).flatMap(texts);
  return [];
}

describe('email', () => {
  it('without advisories is the message it always was', () => {
    expect(email(PROBLEMS)).toEqual({
      subject: 'RuleBeat: 1 new finding',
      text: [
        'RuleBeat found 1 new finding.',
        'Summary: 1 high',
        '',
        '[HIGH] Public storage\n  Resource: st-1\n  Category: reliability',
        '',
        `View in RuleBeat: ${HREF}`,
      ].join('\n'),
    });
  });

  it('an empty advisories list is the same message', () => {
    expect(email(PROBLEMS, [])).toEqual(email(PROBLEMS));
  });

  it('puts advisories in their own labelled section after the problems', () => {
    const { subject, text } = email(PROBLEMS, ADVISORIES);

    expect(subject).toBe('RuleBeat: 1 new finding and 2 new advisories');
    expect(text).toBe([
      'RuleBeat found 1 new finding.',
      'Summary: 1 high',
      '',
      '[HIGH] Public storage\n  Resource: st-1\n  Category: reliability',
      '',
      'Advisories: 2 new',
      'Summary: 1 medium, 1 low',
      '',
      '[MEDIUM] VM size retiring\n  Resource: vm-1\n  Category: reliability',
      '[LOW] VM size retiring\n  Resource: vm-2\n  Category: reliability',
      '',
      `View in RuleBeat: ${HREF}`,
      `View advisories: ${ADVISORIES_HREF}`,
    ].join('\n'));
  });

  it('a message holding only advisories names no problems', () => {
    const { subject, text } = email([], [ADVISORIES[0]!]);

    expect(subject).toBe('RuleBeat: 1 new advisory');
    expect(text).toBe([
      'Advisories: 1 new',
      'Summary: 1 medium',
      '',
      '[MEDIUM] VM size retiring\n  Resource: vm-1\n  Category: reliability',
      '',
      `View advisories: ${ADVISORIES_HREF}`,
    ].join('\n'));
  });

  it('caps the advisory list and says how many more there are', () => {
    const many = Array.from({ length: 12 }, (_, i) => finding('Retiring', `vm-${i}`, 'low', 'advisory'));

    const { text } = email([], many);

    expect(text).toContain('Resource: vm-9\n');
    expect(text).not.toContain('Resource: vm-10');
    expect(text).toContain('... and 2 more.');
  });
});

describe('generic webhook', () => {
  it('without advisories has exactly the fields it always had', () => {
    const body = webhookBody('webhook', PROBLEMS);

    expect(Object.keys(body)).toEqual(['event', 'runId', 'triggeredBy', 'counts', 'totalNewFindings', 'findings', 'scansUrl']);
    expect(body.totalNewFindings).toBe(1);
  });

  it('adds advisories as a separate field and leaves the problem fields as they were', () => {
    const without = webhookBody('webhook', PROBLEMS);
    const body = webhookBody('webhook', PROBLEMS, ADVISORIES);

    const { advisories, ...rest } = body;
    expect(rest).toEqual(without);
    expect(advisories).toEqual({
      totalNewAdvisories: 2,
      counts: { medium: 1, low: 1 },
      findings: [
        { fingerprint: 'fp-VM size retiring', title: 'VM size retiring', severity: 'medium', category: 'reliability',
          resourceId: ADVISORIES[0]!.resourceId, resourceName: 'vm-1', subscriptionId: 'sub-1' },
        { fingerprint: 'fp-VM size retiring', title: 'VM size retiring', severity: 'low', category: 'reliability',
          resourceId: ADVISORIES[1]!.resourceId, resourceName: 'vm-2', subscriptionId: 'sub-1' },
      ],
      advisoriesUrl: ADVISORIES_HREF,
    });
  });

  it('a message holding only advisories has empty problem fields', () => {
    const body = webhookBody('webhook', [], ADVISORIES);

    expect(body.totalNewFindings).toBe(0);
    expect(body.findings).toEqual([]);
    expect((body.advisories as { totalNewAdvisories: number }).totalNewAdvisories).toBe(2);
  });
});

describe('Teams card', () => {
  it('without advisories carries no Advisories section', () => {
    expect(texts(webhookBody('teams', PROBLEMS))).not.toContain('Advisories (2)');
    expect(texts(webhookBody('teams', PROBLEMS)).join('|')).not.toMatch(/advisor/i);
  });

  it('has a labelled Advisories section after the problem table, with its own link', () => {
    const all = texts(webhookBody('teams', PROBLEMS, ADVISORIES));

    expect(all).toContain('RuleBeat: 1 new finding and 2 new advisories');
    expect(all.indexOf('Public storage')).toBeGreaterThan(-1);
    expect(all.indexOf('Advisories (2)')).toBeGreaterThan(all.indexOf('Public storage'));
    expect(all.indexOf('vm-1')).toBeGreaterThan(all.indexOf('Advisories (2)'));
    expect(all).toContain(ADVISORIES_HREF);
  });

  it('a message holding only advisories has no problem table', () => {
    const all = texts(webhookBody('teams', [], ADVISORIES));

    expect(all).toContain('RuleBeat: 2 new advisories');
    expect(all).toContain('Advisories (2)');
    expect(all).not.toContain('Finding');
  });
});

describe('Slack message', () => {
  it('without advisories carries no Advisories section', () => {
    expect(texts(webhookBody('slack', PROBLEMS)).join('|')).not.toMatch(/advisor/i);
  });

  it('has a labelled Advisories section after the problems, with its own link', () => {
    const all = texts(webhookBody('slack', PROBLEMS, ADVISORIES));

    expect(all).toContain('RuleBeat: 1 new finding and 2 new advisories');
    const label = all.findIndex(t => t.startsWith('*Advisories (2)*'));
    expect(label).toBeGreaterThan(all.findIndex(t => t.includes('Public storage')));
    expect(all.findIndex(t => t.includes('vm-1'))).toBeGreaterThan(label);
    expect(all).toContain(ADVISORIES_HREF);
  });

  it('a message holding only advisories is headed by the advisory count', () => {
    const all = texts(webhookBody('slack', [], ADVISORIES));

    expect(all).toContain('RuleBeat: 2 new advisories');
    expect(all.some(t => t.includes('Public storage'))).toBe(false);
  });
});
