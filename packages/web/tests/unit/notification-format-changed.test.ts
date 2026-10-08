/**
 * Issue #193: what a channel is sent about a changed finding, a finding that gained a Row. Changed
 * findings sit in their own labelled "Changed" section in every format, listing each finding and the
 * rows it gained as key: value pairs. A message with no changed findings is exactly what it was
 * before (the other format tests hold those literals).
 */
import { describe, expect, it } from 'vitest';
import type { ChangedFindingDetail, Finding, Severity } from '@/lib/types';
import type { FindingRow } from '@/lib/finding-rows';
import type { ScheduleRun } from '@/lib/schedule-runs';
import { buildPayload } from '@/lib/notifications/format';

const HREF = 'https://rulebeat.example/scans?tab=results&status=new';
const CHANGED_HREF = 'https://rulebeat.example/scans?tab=results&status=open';

const RUN = { id: 'run-1', scheduleId: 'sched-1', triggeredBy: 'schedule' } as ScheduleRun;

function finding(title: string, resourceName: string, severity: Severity, kind: 'state' | 'advisory' = 'state'): Finding {
  return {
    module: 'test', ruleId: `rule-${title}`, fingerprint: `fp-${resourceName}`, severity, category: 'reliability', kind,
    resourceId: `/subscriptions/s/resourceGroups/rg/providers/p/t/${resourceName}`, resourceType: 'p/t', resourceName,
    subscriptionId: 'sub-1', resourceGroup: 'rg', location: 'eastus', title, description: '', recommendation: '',
    remediationSteps: [], evidence: {}, detectedAt: '2026-10-08T00:00:00.000Z',
  } as Finding;
}

function changed(resourceName: string, addedRows: FindingRow[], severity: Severity = 'medium'): ChangedFindingDetail {
  return { ...finding('VM size retiring', resourceName, severity), addedRows };
}

const ONE = [changed('vm-1', [{ retirement: 'TLS 1.0', retiresOn: '2026-11-01' }])];
const NEW_PROBLEM = [finding('Public storage', 'st-1', 'high')];

function email(problems: Finding[], changes: ChangedFindingDetail[], advisories: Finding[] = []) {
  const p = buildPayload('email', problems, HREF, RUN, advisories, HREF, { findings: changes, href: CHANGED_HREF });
  if (p.kind !== 'email') throw new Error('expected an email payload');
  return { subject: p.subject, text: p.text };
}

function webhookBody(type: 'webhook' | 'teams' | 'slack', problems: Finding[], changes: ChangedFindingDetail[]) {
  const p = buildPayload(type, problems, HREF, RUN, [], HREF, { findings: changes, href: CHANGED_HREF });
  if (p.kind !== 'webhook') throw new Error('expected a webhook payload');
  return p.body as Record<string, unknown>;
}

function texts(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(texts);
  if (node && typeof node === 'object') return Object.values(node).flatMap(texts);
  return [];
}

describe('email', () => {
  it('holds only a Changed section when nothing is new', () => {
    expect(email([], ONE)).toEqual({
      subject: 'RuleBeat: 1 changed finding',
      text: [
        'Changed: 1 finding gained rows',
        '',
        '[MEDIUM] VM size retiring\n  Resource: vm-1\n  Category: reliability\n  Added: retirement: TLS 1.0, retiresOn: 2026-11-01',
        '',
        `View changed findings: ${CHANGED_HREF}`,
      ].join('\n'),
    });
  });

  it('puts the Changed section after the new findings and names both in the subject', () => {
    const { subject, text } = email(NEW_PROBLEM, ONE);

    expect(subject).toBe('RuleBeat: 1 new finding and 1 changed finding');
    expect(text.indexOf('RuleBeat found 1 new finding.')).toBe(0);
    expect(text.indexOf('Changed: 1 finding gained rows')).toBeGreaterThan(text.indexOf('[HIGH] Public storage'));
    expect(text).toContain(`View in RuleBeat: ${HREF}`);
    expect(text).toContain(`View changed findings: ${CHANGED_HREF}`);
  });

  it('lists every row a finding gained, one line each, and renders non-text values as JSON', () => {
    const { text } = email([], [changed('vm-1', [{ a: 'x' }, { count: 3, tags: { env: 'prod' }, gone: null }])]);

    expect(text).toContain('  Added: a: x\n  Added: count: 3, tags: {"env":"prod"}, gone: null');
  });

  it('shortens a long value and a long list of rows', () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ n: i, note: 'y'.repeat(200) }));
    const { text } = email([], [changed('vm-1', rows)]);

    expect(text.match(/ {2}Added: /g)).toHaveLength(5);
    expect(text).toContain('  ... and 2 more rows.');
    expect(text).not.toContain('y'.repeat(200));
  });

  it('truncates a long list of changed findings after ten, like new findings', () => {
    const many = Array.from({ length: 12 }, (_, i) => changed(`vm-${i}`, [{ n: i }]));
    const { text } = email([], many);

    expect(text).toContain('Changed: 12 findings gained rows');
    expect(text).toContain('vm-9');
    expect(text).not.toContain('vm-10');
    expect(text).toContain('... and 2 more.');
  });
});

describe('webhook', () => {
  it('adds a changed field with the rows each finding gained, and leaves the other fields alone', () => {
    const body = webhookBody('webhook', NEW_PROBLEM, ONE);

    expect(Object.keys(body)).toEqual(['event', 'runId', 'triggeredBy', 'counts', 'totalNewFindings', 'findings', 'scansUrl', 'changed']);
    expect(body.changed).toEqual({
      totalChangedFindings: 1,
      findings: [{
        fingerprint: 'fp-vm-1', title: 'VM size retiring', severity: 'medium', category: 'reliability',
        resourceId: '/subscriptions/s/resourceGroups/rg/providers/p/t/vm-1', resourceName: 'vm-1', subscriptionId: 'sub-1',
        addedRows: [{ retirement: 'TLS 1.0', retiresOn: '2026-11-01' }],
      }],
      changedUrl: CHANGED_HREF,
    });
  });

  it('truncates the changed findings after twenty', () => {
    const many = Array.from({ length: 22 }, (_, i) => changed(`vm-${i}`, [{ n: i }]));
    const body = webhookBody('webhook', [], many);

    const section = body.changed as { totalChangedFindings: number; findings: unknown[] };
    expect(section.totalChangedFindings).toBe(22);
    expect(section.findings).toHaveLength(20);
  });
});

describe('Teams and Slack', () => {
  it.each(['teams', 'slack'] as const)('%s labels a Changed section and shows the added row', type => {
    const strings = texts(webhookBody(type, NEW_PROBLEM, ONE));

    expect(strings.some(s => s.includes('Changed (1)'))).toBe(true);
    expect(strings.some(s => s.includes('VM size retiring') && s.includes('vm-1'))).toBe(true);
    expect(strings.some(s => s.includes('retirement: TLS 1.0, retiresOn: 2026-11-01'))).toBe(true);
    expect(strings).toContain(CHANGED_HREF);
  });

  it.each(['teams', 'slack'] as const)('%s truncates a long list of changed findings after five', type => {
    const many = Array.from({ length: 7 }, (_, i) => changed(`vm-${i}`, [{ n: i }]));
    const strings = texts(webhookBody(type, [], many));

    expect(strings.some(s => s.includes('vm-4'))).toBe(true);
    expect(strings.some(s => s.includes('vm-5'))).toBe(false);
    expect(strings.some(s => s.includes('and 2 more'))).toBe(true);
  });
});
