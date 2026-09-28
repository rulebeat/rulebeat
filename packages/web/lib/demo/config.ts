import { DEFAULT_SEED } from './prng';

/** Every Data set this release can generate a Demo from. Adding one is a new entry here plus its
 *  generator in `./run.ts`'s `DATA_SET_GENERATORS`. */
export const DEMO_DATA_SETS = ['contoso'] as const;
export type DemoDataSet = (typeof DEMO_DATA_SETS)[number];

export interface DemoConfig {
  dataSet: DemoDataSet;
  seed: number;
}

/** A Demo setting the process cannot start with. The message is written for the operator. */
export class DemoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DemoConfigError';
  }
}

function parseSeed(raw: string): number {
  const text = raw.trim();
  const value = /^0x[0-9a-f]+$/i.test(text) ? Number.parseInt(text.slice(2), 16)
    : /^\d+$/.test(text) ? Number(text)
    : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new DemoConfigError(
      `RULEBEAT_DEMO_SEED must be a whole number from 0 to 4294967295, written in decimal or as 0x hex. Got "${raw}".`,
    );
  }
  return value;
}

/** Reads the Demo's Data set and Seed from the environment. Only meaningful under RULEBEAT_DEMO=1. */
export function resolveDemoConfig(env: Record<string, string | undefined> = process.env): DemoConfig {
  const rawDataSet = env.RULEBEAT_DEMO_DATASET?.trim() || DEMO_DATA_SETS[0];
  if (!(DEMO_DATA_SETS as readonly string[]).includes(rawDataSet)) {
    throw new DemoConfigError(
      `RULEBEAT_DEMO_DATASET "${rawDataSet}" is not a Data set this release ships. Available: ${DEMO_DATA_SETS.join(', ')}.`,
    );
  }
  const rawSeed = env.RULEBEAT_DEMO_SEED;
  return {
    dataSet: rawDataSet as DemoDataSet,
    seed: rawSeed === undefined || rawSeed.trim() === '' ? DEFAULT_SEED : parseSeed(rawSeed),
  };
}

/** When a Demo resets on its own, and whether it is dressed for a screen recording. */
export interface DemoResetSettings {
  /** Minutes between timed Resets. 0 means the timer is off. */
  resetMinutes: number;
  /** The Recording presentation: no banner, and the timer forced off. */
  recording: boolean;
}

export const DEFAULT_RESET_MINUTES = 60;
const MAX_RESET_MINUTES = 7 * 24 * 60;

/** Reads the Reset timer and the Recording presentation from the environment. */
export function resolveDemoResetSettings(env: Record<string, string | undefined> = process.env): DemoResetSettings {
  const recording = env.RULEBEAT_DEMO_RECORDING?.trim() === '1';
  const raw = env.RULEBEAT_DEMO_RESET_MINUTES?.trim();
  let minutes = DEFAULT_RESET_MINUTES;
  if (raw !== undefined && raw !== '') {
    if (!/^\d+$/.test(raw) || Number(raw) > MAX_RESET_MINUTES) {
      throw new DemoConfigError(
        `RULEBEAT_DEMO_RESET_MINUTES must be a whole number of minutes from 0 to ${MAX_RESET_MINUTES}, where 0 turns the timer off. Got "${raw}".`,
      );
    }
    minutes = Number(raw);
  }
  return { resetMinutes: recording ? 0 : minutes, recording };
}
