/**
 * The Demo's Data set and Seed come from RULEBEAT_DEMO_DATASET and RULEBEAT_DEMO_SEED. A value the
 * Demo cannot use stops the process at boot, so each rejection here is one an operator would
 * otherwise meet as a Demo quietly generated from something they did not ask for.
 */
import { describe, expect, it } from 'vitest';
import { DemoConfigError, resolveDemoConfig } from '@/lib/demo/config';
import { DEFAULT_SEED } from '@/lib/demo/prng';

describe('resolveDemoConfig()', () => {
  it('defaults to the contoso Data set and the default Seed', () => {
    expect(resolveDemoConfig({})).toEqual({ dataSet: 'contoso', seed: DEFAULT_SEED });
  });

  it('treats blank values as unset', () => {
    expect(resolveDemoConfig({ RULEBEAT_DEMO_DATASET: ' ', RULEBEAT_DEMO_SEED: '' }))
      .toEqual({ dataSet: 'contoso', seed: DEFAULT_SEED });
  });

  it('reads a Seed written in decimal or as 0x hex', () => {
    expect(resolveDemoConfig({ RULEBEAT_DEMO_SEED: '42' }).seed).toBe(42);
    expect(resolveDemoConfig({ RULEBEAT_DEMO_SEED: '0x2A' }).seed).toBe(42);
    expect(resolveDemoConfig({ RULEBEAT_DEMO_SEED: '4294967295' }).seed).toBe(0xffffffff);
    expect(resolveDemoConfig({ RULEBEAT_DEMO_SEED: '0' }).seed).toBe(0);
  });

  it.each(['-1', '4294967296', '1.5', 'abc', '0x', '12abc'])('rejects the Seed %s', raw => {
    expect(() => resolveDemoConfig({ RULEBEAT_DEMO_SEED: raw })).toThrow(DemoConfigError);
  });

  it('rejects a Data set this release does not ship, naming the ones it does', () => {
    expect(() => resolveDemoConfig({ RULEBEAT_DEMO_DATASET: 'fabrikam' })).toThrow(/Available: contoso/);
  });
});
