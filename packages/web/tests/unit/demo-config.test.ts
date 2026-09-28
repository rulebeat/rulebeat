/**
 * The Demo's Data set and Seed come from RULEBEAT_DEMO_DATASET and RULEBEAT_DEMO_SEED. A value the
 * Demo cannot use stops the process at boot, so each rejection here is one an operator would
 * otherwise meet as a Demo quietly generated from something they did not ask for.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_RESET_MINUTES, DemoConfigError, resolveDemoConfig, resolveDemoResetSettings } from '@/lib/demo/config';
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

describe('resolveDemoResetSettings()', () => {
  it('resets every 60 minutes by default, with the banner shown', () => {
    expect(DEFAULT_RESET_MINUTES).toBe(60);
    expect(resolveDemoResetSettings({})).toEqual({ resetMinutes: 60, recording: false });
    expect(resolveDemoResetSettings({ RULEBEAT_DEMO_RESET_MINUTES: ' ' })).toEqual({ resetMinutes: 60, recording: false });
  });

  it('reads the interval, where 0 turns the timer off', () => {
    expect(resolveDemoResetSettings({ RULEBEAT_DEMO_RESET_MINUTES: '30' }).resetMinutes).toBe(30);
    expect(resolveDemoResetSettings({ RULEBEAT_DEMO_RESET_MINUTES: '0' }).resetMinutes).toBe(0);
  });

  it('turns the timer off while recording, whatever the interval says', () => {
    expect(resolveDemoResetSettings({ RULEBEAT_DEMO_RECORDING: '1', RULEBEAT_DEMO_RESET_MINUTES: '15' }))
      .toEqual({ resetMinutes: 0, recording: true });
  });

  it.each(['-5', '1.5', 'hourly', '10081'])('rejects the interval %s', raw => {
    expect(() => resolveDemoResetSettings({ RULEBEAT_DEMO_RESET_MINUTES: raw })).toThrow(DemoConfigError);
  });
});
