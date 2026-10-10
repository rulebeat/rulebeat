/**
 * Issue #212: Activity findings go to every channel, in their own labelled "Activity" section with a
 * link to the Activity tab, in every format. The Problems section, its counts and its link cover
 * Problems only. The webhook's top-level fields keep holding Problems and Activity together, so a
 * consumer reading them sees what it always did, and Activity is repeated in its own `activity` field.
 * A changed finding links to the open findings on its own tab.
 */
import { describe, expect, it } from 'vitest';
import type { ChangedFindingDetail, Finding, Severity } from '@/lib/types';
import type { ScheduleRun } from '@/lib/schedule-runs';
import { buildPayload } from '@/lib/notifications/format';

const HREF = 'https://rulebeat.example/scans?tab=results&status=new';
const ACTIVITY_HREF = 'https://rulebeat.example/scans?tab=activity&status=new';
const CHANGED = {
  href: 'https://rulebeat.example/scans?tab=results&status=open',
  activityHref: 'https://rulebeat.example/scans?tab=activity&status=open',
  advisoriesHref: 'https://rulebeat.example/scans?tab=advisories&status=open',
};

const RUN = { id: 'run-1', scheduleId: 'sched-1', triggeredBy: 'schedule' } as ScheduleRun;

function finding(title: string, resourceName: string, severity: Severity, kind: 'state' | 'activity' | 'advisory'): Finding {
  return {
    module: 'test', ruleId: `rule-${title}`, fingerprint: `fp-${resourceName}`, severity, category: 'security', kind,
    resourceId: `/subscriptions/s/resourceGroups/rg/providers/p/t/${resourceName}`, resourceType: 'p/t', resourceName,
    subscriptionId: 'sub-1', resourceGroup: 'rg', location: 'eastus', title, description: '', recommendation: '',
    remediationSteps: [], evidence: {}, detectedAt: '2026-10-08T00:00:00.000Z',
  } as Finding;
}

const PROBLEM = finding('Public storage', 'st-1', 'high', 'state');
const ACTIVITY = finding('Sign-in burst', 'burst-1', 'medium', 'activity');

function payload(type: 'email' | 'webhook' | 'teams' | 'slack', findings: Finding[], changes: ChangedFindingDetail[] = []) {
  return buildPayload(type, findings, HREF, RUN, [], HREF, { findings: changes, ...CHANGED }, ACTIVITY_HREF);
}

function email(findings: Finding[], changes: ChangedFindingDetail[] = []) {
  const p = payload('email', findings, changes);
  if (p.kind !== 'email') throw new Error('expected an email payload');
  return { subject: p.subject, text: p.text };
}

function body(type: 'webhook' | 'teams' | 'slack', findings: Finding[], changes: ChangedFindingDetail[] = []) {
  const p = payload(type, findings, changes);
  if (p.kind !== 'webhook') throw new Error('expected a webhook payload');
  return p.body as Record<string, unknown>;
}

function texts(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(texts);
  if (node && typeof node === 'object') return Object.values(node).flatMap(texts);
  return [];
}

const changedOf = (f: Finding): ChangedFindingDetail => ({ ...f, addedRows: [{ user: 'a' }] });

describe('email', () => {
  it('holds only an Activity section when nothing else is new', () => {
    expect(email([ACTIVITY])).toEqual({
      subject: 'RuleBeat: 1 new activity finding',
      text: [
        'Activity: 1 new',
        'Summary: 1 medium',
        '',
        '[MEDIUM] Sign-in burst\n  Resource: burst-1\n  Category: security',
        '',
        `View activity: ${ACTIVITY_HREF}`,
      ].join('\n'),
    });
  });

  it('counts only the Problems in the Problems section, and puts Activity after it', () => {
    const { subject, text } = email([ACTIVITY, PROBLEM]);

    expect(subject).toBe('RuleBeat: 1 new finding and 1 new activity finding');
    expect(text.indexOf('RuleBeat found 1 new finding.\nSummary: 1 high\n')).toBe(0);
    expect(text.indexOf('Activity: 1 new')).toBeGreaterThan(text.indexOf('[HIGH] Public storage'));
    expect(text).toContain(`View in RuleBeat: ${HREF}`);
    expect(text).toContain(`View activity: ${ACTIVITY_HREF}`);
  });

  it('without Activity has no Activity section', () => {
    const { text } = email([PROBLEM]);

    expect(text).not.toContain('Activity');
    expect(text).not.toContain(ACTIVITY_HREF);
  });
});

describe('webhook', () => {
  it('keeps Activity in the top-level fields, in arrival order, and repeats it in its own field', () => {
    const b = body('webhook', [ACTIVITY, PROBLEM]);

    expect(Object.keys(b)).toEqual(['event', 'runId', 'triggeredBy', 'counts', 'totalNewFindings', 'findings', 'scansUrl', 'activity']);
    expect(b.totalNewFindings).toBe(2);
    expect(b.counts).toEqual({ medium: 1, high: 1 });
    expect((b.findings as { resourceName: string }[]).map(f => f.resourceName)).toEqual(['burst-1', 'st-1']);
    expect(b.scansUrl).toBe(HREF);
    expect(b.activity).toEqual({
      totalNewActivity: 1,
      counts: { medium: 1 },
      findings: [{
        fingerprint: 'fp-burst-1', title: 'Sign-in burst', severity: 'medium', category: 'security',
        resourceId: '/subscriptions/s/resourceGroups/rg/providers/p/t/burst-1', resourceName: 'burst-1', subscriptionId: 'sub-1',
      }],
      activityUrl: ACTIVITY_HREF,
    });
  });

  it('has no activity field without Activity', () => {
    expect(body('webhook', [PROBLEM])).not.toHaveProperty('activity');
  });
});

describe('Teams and Slack', () => {
  it.each(['teams', 'slack'] as const)('%s labels an Activity section and links it to the Activity tab', type => {
    const strings = texts(body(type, [PROBLEM, ACTIVITY]));

    expect(strings.some(s => s.includes('Activity (1)'))).toBe(true);
    expect(strings).toContain('View activity');
    expect(strings).toContain(ACTIVITY_HREF);
    expect(strings).toContain(HREF);
  });

  it.each(['teams', 'slack'] as const)('%s with only Activity has no Problems section or link', type => {
    const strings = texts(body(type, [ACTIVITY]));

    expect(strings).toContain('RuleBeat: 1 new activity finding');
    expect(strings).not.toContain(HREF);
    expect(strings.some(s => s.includes('new finding') && !s.includes('activity'))).toBe(false);
  });
});

describe('changed findings', () => {
  it('link a changed Activity finding to the open findings on the Activity tab', () => {
    const { text } = email([], [changedOf(ACTIVITY)]);

    expect(text).toContain(`View changed activity: ${CHANGED.activityHref}`);
    expect(text).not.toContain(CHANGED.href);
  });

  it('give each tab its own link, in tab order', () => {
    const changes = [changedOf(ACTIVITY), changedOf(finding('VM size retiring', 'vm-1', 'low', 'advisory')), changedOf(PROBLEM)];
    const { text } = email([], changes);

    expect(text.split('\n').filter(line => line.startsWith('View changed'))).toEqual([
      `View changed findings: ${CHANGED.href}`,
      `View changed activity: ${CHANGED.activityHref}`,
      `View changed advisories: ${CHANGED.advisoriesHref}`,
    ]);
  });

  it.each(['teams', 'slack'] as const)('%s links a changed Activity finding to the Activity tab', type => {
    const strings = texts(body(type, [], [changedOf(ACTIVITY)]));

    expect(strings).toContain('View changed activity');
    expect(strings).toContain(CHANGED.activityHref);
    expect(strings).not.toContain(CHANGED.href);
  });

  it('point the webhook changedUrl at the only tab that changed, and list every tab in changedUrls', () => {
    expect((body('webhook', [], [changedOf(ACTIVITY)]).changed as Record<string, unknown>)).toMatchObject({
      changedUrl: CHANGED.activityHref,
      changedUrls: { activity: CHANGED.activityHref },
    });
    expect((body('webhook', [], [changedOf(ACTIVITY), changedOf(PROBLEM)]).changed as Record<string, unknown>)).toMatchObject({
      changedUrl: CHANGED.href,
      changedUrls: { results: CHANGED.href, activity: CHANGED.activityHref },
    });
  });
});
