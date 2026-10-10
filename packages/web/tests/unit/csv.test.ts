/**
 * The shared CSV cell encoder behind the audit export and the findings export. The audit route
 * is tested end to end in audit-export-route.test.ts; the findings export is built inside a
 * client component that needs a DOM and a Blob download, so its cells are pinned here and a
 * source check confirms each export button (findings, query results) uses this encoder rather
 * than a copy.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { csvCell, csvRow } from '@/lib/csv';

describe('csvRow', () => {
  it('encodes every cell the same way csvCell does, header or data row alike', () => {
    expect(csvRow(['Severity', 'a,b', 'say "hi"', 'one\ntwo', '=SUM(A1)'])).toBe(
      'Severity,"a,b","say ""hi""","one\ntwo",\'=SUM(A1)',
    );
  });

  it('renders an empty row as an empty string', () => {
    expect(csvRow([])).toBe('');
  });
});

describe('csvCell', () => {
  it.each([
    ['=1+1', "'=1+1"],
    ['+1', "'+1"],
    ['-1', "'-1"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\tx', "'\tx"],
  ])('prefixes an apostrophe on %j', (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  it('prefixes and quotes a value that starts with a carriage return', () => {
    expect(csvCell('\rx')).toBe('"\'\rx"');
  });

  it('guards a finding resource name or evidence value that starts with a formula character', () => {
    expect(csvCell('=HYPERLINK("http://example.com","click")')).toBe(
      '"\'=HYPERLINK(""http://example.com"",""click"")"',
    );
  });

  it.each([
    ['a,b', '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ['one\ntwo', '"one\ntwo"'],
    ['one\rtwo', '"one\rtwo"'],
    ['one\r\ntwo', '"one\r\ntwo"'],
  ])('quotes %j', (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  it('leaves plain text and mid-value formula characters alone', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a=b-c+d@e')).toBe('a=b-c+d@e');
  });

  it('renders null and undefined as an empty cell', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('leaves numbers and booleans as they are, negative numbers included', () => {
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(3)).toBe('3');
    expect(csvCell(true)).toBe('true');
  });

  it('serialises an object as quoted JSON', () => {
    expect(csvCell({ a: 1, b: 'x' })).toBe('"{""a"":1,""b"":""x""}"');
  });
});

describe.each([
  ['findings export', '../lib/findings-export.ts'],
  ['query export button', 'query/query-export-button.tsx'],
])('%s', (_name, file) => {
  const source = readFileSync(path.resolve(__dirname, '../../components', file), 'utf8');

  it('uses the shared encoder and keeps no copy of its own', () => {
    expect(source).toContain("from '@/lib/csv'");
    expect(source).not.toMatch(/function csvCell/);
  });
});
