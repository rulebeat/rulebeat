/**
 * ADR 0013: the version-equality table lives in lib/trend-version-equality.ts and is repeated in
 * docs/public/posture.md under "When two counts are compared". This reads the table off that heading
 * and compares it with the module, so changing one cell on either side fails the suite.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION_EQUALITY, equalFormulaVersions, findingCountCountsEqual, formulaCountsEqual } from '@/lib/trend-version-equality';

const POSTURE_DOC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'docs', 'public', 'posture.md');
const HEADING = '## When two counts are compared';

interface DocRow { label: string; formula: number[]; findingCount: number[] }

const versions = (cell: string): number[] => cell.split(',').map(part => Number(part.trim()));

/** The table under the heading: every pipe row after the header and separator, up to the first line
 *  that is not a table row. */
function tableUnderHeading(markdown: string): DocRow[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex(line => line.trim() === HEADING);
  if (start === -1) throw new Error(`posture.md has no "${HEADING}" heading`);
  const firstRow = lines.findIndex((line, i) => i > start && line.startsWith('|'));
  if (firstRow === -1) throw new Error('no table under the heading');
  const rows: DocRow[] = [];
  for (const line of lines.slice(firstRow + 2)) {
    if (!line.startsWith('|')) break;
    const [label, formula, findingCount] = line.split('|').slice(1, -1).map(cell => cell.trim());
    rows.push({ label: label!, formula: versions(formula!), findingCount: versions(findingCount!) });
  }
  return rows;
}

const moduleRows = (): DocRow[] => VERSION_EQUALITY.map(({ label, formula, findingCount }) => ({ label, formula: [...formula], findingCount: [...findingCount] }));

describe('the version-equality table and posture.md', () => {
  const doc = readFileSync(POSTURE_DOC, 'utf8');

  it('agree, row for row', () => {
    expect(tableUnderHeading(doc)).toEqual(moduleRows());
  });

  it('disagree when one cell of the doc is changed', () => {
    const edited = doc.replace('| One subscription | 3 | 1 |', '| One subscription | 2, 3 | 1 |');
    expect(edited).not.toBe(doc);
    expect(tableUnderHeading(edited)).not.toEqual(moduleRows());
  });
});

describe('the version-equality lookups', () => {
  it('count formulas 2 and 3 equal install-wide, and only 3 at a subscription or the Directory', () => {
    expect([1, 2, 3].map(v => formulaCountsEqual('install', v))).toEqual([false, true, true]);
    expect([1, 2, 3].map(v => formulaCountsEqual('subscription', v))).toEqual([false, false, true]);
    expect([1, 2, 3].map(v => formulaCountsEqual('directory', v))).toEqual([false, false, true]);
    expect(equalFormulaVersions('install')).toEqual([2, 3]);
  });

  it('count finding-count version 1 equal at every level, and 0 (not recorded) at none', () => {
    for (const level of ['install', 'subscription', 'directory'] as const) {
      expect(findingCountCountsEqual(level, 1)).toBe(true);
      expect(findingCountCountsEqual(level, 0)).toBe(false);
    }
  });
});
