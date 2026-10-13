/**
 * #271: a Directory finding has no subscription, so a notification names it "Directory" where a
 * subscription would be named, not a blank or a GUID. The webhook payload is the one format that lists
 * each finding's subscription.
 */
import { describe, expect, it } from 'vitest';
import type { Finding } from '@/lib/types';
import type { ScheduleRun } from '@/lib/schedule-runs';
import { buildPayload } from '@/lib/notifications/format';

const HREF = 'https://rulebeat.example/scans?tab=results&status=new';
const RUN = { id: 'run-1', scheduleId: 'sched-1', triggeredBy: 'schedule' } as ScheduleRun;
const CHANGED = { href: HREF, activityHref: HREF, advisoriesHref: HREF };

const finding = (name: string, over: Partial<Finding>): Finding => ({
  module: 'test', ruleId: 'rule-1', fingerprint: `fp-${name}`, severity: 'high', category: 'identity',
  resourceId: `/x/${name}`, resourceType: 't', resourceName: name, title: 'Expiring secret', description: '',
  recommendation: '', remediationSteps: [], evidence: {}, detectedAt: '2026-10-08T00:00:00.000Z',
  subscriptionId: '', placement: 'directory', ...over,
});

function webhookFindings(findings: Finding[]) {
  const payload = buildPayload('webhook', findings, HREF, RUN, [], HREF, { findings: [], ...CHANGED }, HREF);
  if (payload.kind !== 'webhook') throw new Error('expected a webhook payload');
  return (payload.body as { findings: { resourceName: string; subscriptionId: string }[] }).findings;
}

describe('a webhook notification names where each finding sits', () => {
  it('calls a Directory finding Directory, and any other finding by its subscription', () => {
    const listed = webhookFindings([
      finding('app-1', {}),
      finding('vm-1', { subscriptionId: '11111111-1111-1111-1111-111111111111', placement: 'resource' }),
    ]);
    expect(listed.map(f => [f.resourceName, f.subscriptionId])).toEqual([
      ['app-1', 'Directory'],
      ['vm-1', '11111111-1111-1111-1111-111111111111'],
    ]);
  });
});
