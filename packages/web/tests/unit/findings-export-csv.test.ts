/**
 * The findings export button's CSV text. Its evidence columns come straight from rule queries
 * and Azure resource data, so an evidence key can hold a comma, a quote, a newline or a leading
 * formula character; the header row must be guarded the same way a data cell is. Tested at the
 * extracted pure function rather than by rendering ExportButton (no React render layer here; see
 * tests/unit/trend-tooltip-label.test.ts for the same pattern).
 */
import { describe, expect, it } from 'vitest';
import { buildFindingsCsv } from '@/components/findings/export-button';
import type { Finding } from '@/lib/types';

function finding(evidence: Record<string, unknown>): Finding {
  return {
    module: 'security',
    ruleId: 'rule-1',
    fingerprint: 'fp-1',
    severity: 'high',
    category: 'security',
    resourceId: '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Storage/x',
    resourceType: 'Microsoft.Storage/storageAccounts',
    resourceName: 'x',
    subscriptionId: 'sub',
    resourceGroup: 'rg',
    location: 'eastus',
    title: 'Example finding',
    description: 'desc',
    evidence,
    recommendation: 'fix it',
    remediationSteps: [],
    azurePortalLink: '',
    detectedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('buildFindingsCsv', () => {
  it('guards an evidence key holding a comma, a quote, a newline, and a leading formula character', () => {
    const csv = buildFindingsCsv([
      finding({ 'a,b': 1, 'say "hi"': 2, 'one\ntwo': 3, '=SUM(A1)': 4 }),
    ]);
    // Evidence keys are sorted, so the quoted newline key sits mid-header; a naive split('\n')
    // on the whole CSV would cut at that embedded newline, so compare the known header prefix
    // instead of trying to isolate "line one" by splitting.
    const expectedHeader =
      'Severity,Title,Resource,ResourceGroup,Location,Subscription,ResourceType,RuleId,Violation,'
      + 'DetectedAt,PortalLink,\'=SUM(A1),"a,b","one\ntwo","say ""hi"""';
    expect(csv.startsWith(`${expectedHeader}\n`)).toBe(true);
  });

  it('writes one line per row a finding holds, repeating the finding\'s own fields', () => {
    const multi = { ...finding({ owner: 'a' }), rows: [{ owner: 'a' }, { owner: 'b' }, { owner: 'c' }] };
    const lines = buildFindingsCsv([multi]).split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]!.endsWith(',owner')).toBe(true);
    expect(lines.slice(1).map(l => l.split(',').pop())).toEqual(['a', 'b', 'c']);
    expect(new Set(lines.slice(1).map(l => l.slice(0, l.lastIndexOf(',')))).size).toBe(1);
  });

  it('gives every key any row carries its own column, blank where a row lacks it', () => {
    const multi = { ...finding({ a: 1 }), rows: [{ a: 1 }, { b: 2 }] };
    const lines = buildFindingsCsv([multi]).split('\n');
    expect(lines[0]!.endsWith(',a,b')).toBe(true);
    expect(lines[1]!.endsWith(',1,')).toBe(true);
    expect(lines[2]!.endsWith(',,2')).toBe(true);
  });

  it('writes one line for a finding with no rows, and reads an older finding\'s evidence as its one row', () => {
    expect(buildFindingsCsv([finding({})]).split('\n')).toHaveLength(2);
    const older = buildFindingsCsv([finding({ owner: 'a' })]).split('\n');
    expect(older).toHaveLength(2);
    expect(older[1]!.endsWith(',a')).toBe(true);
  });
});
