/**
 * The findings export button's CSV text. Its evidence columns come straight from rule queries
 * and Azure resource data, so an evidence key can hold a comma, a quote, a newline or a leading
 * formula character; the header row must be guarded the same way a data cell is. Tested at the
 * extracted pure function rather than by rendering ExportButton (no React render layer here; see
 * tests/unit/trend-tooltip-label.test.ts for the same pattern).
 */
import { describe, expect, it } from 'vitest';
import { CsvWriter, JsonWriter, buildFindingsCsv, buildFindingsJson } from '@/lib/findings-export';
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

describe('the pieces the export route writes', () => {
  const own = finding({});
  const { evidence: _evidence, ...bare } = own;

  it('write a finding that holds no rows as one blank line, however it arrives', () => {
    const whole = new CsvWriter([], false);
    expect(whole.piece({ finding: bare, rows: [], start: true, end: true }).split('\n')).toEqual(['', 'high,Example finding,x,rg,eastus,sub,Microsoft.Storage/storageAccounts,rule-1,,2026-01-01T00:00:00.000Z,']);
    // A finding in two pieces whose second holds no rows has its one line already.
    const split = new CsvWriter(['owner'], false);
    const text = split.piece({ finding: bare, rows: [{ owner: 'a' }], start: true, end: false }) + split.piece({ finding: bare, rows: [], start: false, end: true });
    expect(text.split('\n')).toHaveLength(2);
  });

  it('write the JSON of a finding the way buildFindingsJson does: rows without builder metadata, then its first row and rule', () => {
    const rule = { field: 'zone', operator: 'eq', value: '1' };
    const held = { ...bare, rows: [{ _rule: rule, zone: '1' }, { zone: '2' }], evidence: { _rule: rule, zone: '1' } };
    const writer = new JsonWriter();
    const text = writer.piece({ finding: bare, rows: held.rows.slice(0, 1), start: true, end: false })
      + writer.piece({ finding: bare, rows: held.rows.slice(1), start: false, end: true }) + writer.close();
    expect(text).toBe(buildFindingsJson([held]));
    expect(Object.keys(JSON.parse(text)[0]).slice(-3)).toEqual(['rows', 'evidence', 'violatedRule']);
    expect(text).not.toContain('_rule');
    expect(JSON.parse(text)[0].violatedRule).toEqual(rule);
  });

  it('write a JSON finding with no rows as an empty list and an empty evidence, with no rule', () => {
    const writer = new JsonWriter();
    const text = writer.piece({ finding: bare, rows: [], start: true, end: true }) + writer.close();
    expect(JSON.parse(text)[0]).toMatchObject({ rows: [], evidence: {} });
    expect(JSON.parse(text)[0]).not.toHaveProperty('violatedRule');
    expect(text).toBe(buildFindingsJson([{ ...bare, rows: [], evidence: {} }]));
  });
});
