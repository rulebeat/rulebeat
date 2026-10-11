/**
 * Ticket #221: the APRL transform pairs a recommendation with the `.kql` file named after its guid,
 * never with whichever file comes next. Driven through the pure pairing step with in-memory input.
 */
import { describe, expect, it } from 'vitest';
import { pairRecommendations, type AprlRecommendation } from '@/lib/aprl-pairing';

const G1 = '11111111-1111-4111-8111-111111111111';
const G2 = '22222222-2222-4222-8222-222222222222';
const G3 = '33333333-3333-4333-8333-333333333333';
const DIR = 'azure-resources/microsoft.compute/virtualmachines/code';

const rec = (aprlGuid: string, over: Partial<AprlRecommendation> = {}): AprlRecommendation => ({
  aprlGuid, description: `Recommendation ${aprlGuid.slice(0, 2)}`, automationAvailable: true,
  recommendationMetadataState: 'Active', ...over,
});
const file = (guid: string, text: string) => [`${DIR}/${guid}.kql`, text] as const;
const files = (...entries: Array<readonly [string, string]>) => Object.fromEntries(entries);
const queries = (recs: AprlRecommendation[], f: Record<string, string>) =>
  Object.fromEntries(pairRecommendations(recs, f).selected.map(s => [s.guid, s.rawKql]));

describe('pairRecommendations', () => {
  it('gives each recommendation the file named after its guid', () => {
    expect(queries([rec(G1), rec(G2)], files(file(G1, 'resources | where a == 1'), file(G2, 'resources | where b == 2')))).toEqual({
      [G1]: 'resources | where a == 1',
      [G2]: 'resources | where b == 2',
    });
  });

  it('gives a recommendation with no file of its own no query, and does not ship it', () => {
    const result = pairRecommendations([rec(G1), rec(G2)], files(file(G2, 'resources | where b == 2')));
    expect(result.selected.map(s => s.guid)).toEqual([G2]);
    expect(result.skipped).toBe(1);
  });

  it('does not let a skipped recommendation shift the pairing of the ones after it', () => {
    const recs = [
      rec(G1, { recommendationMetadataState: 'Retired' }),
      rec(G2, { automationAvailable: false }),
      rec(G3),
    ];
    // Positionally, G3 would take the first file of the folder: G1's.
    expect(queries(recs, files(file(G1, 'resources | where a == 1'), file(G3, 'resources | where c == 3')))).toEqual({
      [G3]: 'resources | where c == 3',
    });
  });

  it('is not affected by the order the files arrive in', () => {
    const recs = [rec(G1), rec(G2), rec(G3)];
    const a = [file(G1, 'q1'), file(G2, 'q2'), file(G3, 'q3')];
    expect(queries(recs, files(...a.reverse()))).toEqual({ [G1]: 'q1', [G2]: 'q2', [G3]: 'q3' });
  });

  it('matches the guid whatever case the file or the YAML spells it in', () => {
    const result = pairRecommendations([rec(G1.toUpperCase())], files(file(G1, 'resources | take 1')));
    expect(result.selected).toMatchObject([{ guid: G1.toUpperCase(), rawKql: 'resources | take 1' }]);
  });

  it('reports a file whose name is not a guid, and pairs it with nothing', () => {
    const odd = `${DIR}/cm-1.kql`;
    const result = pairRecommendations([rec(G1)], files([odd, 'resources | where odd == 1'], file(G1, 'resources | where a == 1')));
    expect(result.unpairedFiles).toEqual([odd]);
    expect(result.selected).toMatchObject([{ guid: G1, rawKql: 'resources | where a == 1' }]);
  });

  it('does not hand a non-guid file to a recommendation that has no file of its own', () => {
    const result = pairRecommendations([rec(G1)], files([`${DIR}/cm-1.kql`, 'resources | where odd == 1']));
    expect(result.selected).toEqual([]);
  });

  it('lets an inline query win over a file', () => {
    expect(queries([rec(G1, { query: '  resources | where inline == 1  ' })], files(file(G1, 'resources | where file == 1')))).toEqual({
      [G1]: 'resources | where inline == 1',
    });
  });

  it('treats a file with no text as no query', () => {
    expect(pairRecommendations([rec(G1)], files(file(G1, '  \n'))).selected).toEqual([]);
  });

  it('leaves out retired, preview and disabled recommendations and ones without automation', () => {
    const recs = ['Retired', 'Preview', 'Disabled'].map((state, i) =>
      rec(`${i}0000000-0000-4000-8000-000000000000`, { recommendationMetadataState: state }));
    recs.push(rec(G1, { automationAvailable: 'false' }));
    const f = files(...recs.map(r => file(r.aprlGuid!, 'resources | take 1')));
    expect(pairRecommendations(recs, f).selected).toEqual([]);
  });

  it('accepts automationAvailable written as the string "true"', () => {
    expect(queries([rec(G1, { automationAvailable: 'true' })], files(file(G1, 'q')))).toEqual({ [G1]: 'q' });
  });

  describe('a query that is only comments', () => {
    it.each([
      ['a placeholder note', '// under-development'],
      ['a note with no space after the slashes', '//cannot-be-validated-with-arg'],
      ['several comment lines with blank lines between them', '// one\n\n   // two\r\n\n//three\n'],
    ])('is not shipped and is counted as skipped: %s', (_label, text) => {
      const result = pairRecommendations([rec(G1), rec(G2)], files(file(G1, text), file(G2, 'resources | where b == 2')));
      expect(result.selected.map(s => s.guid)).toEqual([G2]);
      expect(result.skipped).toBe(1);
    });

    it('is not shipped when it is the inline query, and the file is not tried instead', () => {
      const result = pairRecommendations([rec(G1, { query: '// under-development' })], files(file(G1, 'resources | where file == 1')));
      expect(result.selected).toEqual([]);
      expect(result.skipped).toBe(1);
    });
  });

  it('ships a query that has real KQL between or around comments, with its text unchanged', () => {
    const text = '// header\nresources\n// why this filter\n| where a == 1 // trailing\n// footer';
    expect(queries([rec(G1)], files(file(G1, text)))).toEqual({ [G1]: text });
    expect(queries([rec(G1, { query: `// note\n${'resources | take 1'}` })], {})).toEqual({ [G1]: '// note\nresources | take 1' });
  });
});
