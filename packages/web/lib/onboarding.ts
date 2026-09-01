import { getMeta, setMeta } from './db/meta';

/**
 * Tracks the first-run setup wizard (B3). Backed by a single `meta` row so the marker survives
 * restarts without a dedicated table.
 *
 * `pending` is set once, at seed time, based on whether any users existed before this install's
 * first startup — never derived from "is the marker absent", which would put every *existing*
 * customer's admin into the wizard on their next page load. See `seedOnboardingState()` in
 * `lib/db/migrate.ts`.
 */

const META_KEY = 'onboarding-v1';

export type OnboardingStatus = 'pending' | 'skipped' | 'done';

export interface OnboardingState {
  status: OnboardingStatus;
  /** 1..4 — where a returning admin resumes. */
  lastStep: number;
  completedAt: string | null;
  /** Email, for the audit trail. */
  completedBy: string | null;
}

const DEFAULT_STATE: OnboardingState = { status: 'skipped', lastStep: 1, completedAt: null, completedBy: null };

function isOnboardingStatus(value: unknown): value is OnboardingStatus {
  return value === 'pending' || value === 'skipped' || value === 'done';
}

/**
 * Tolerant parse. A malformed or missing row degrades to `skipped` rather than throwing — a corrupt
 * meta value must never be able to trap every admin in the wizard or 500 the whole app shell.
 */
export async function getOnboardingState(): Promise<OnboardingState> {
  const raw = await getMeta(META_KEY);
  if (!raw) return DEFAULT_STATE;
  try {
    const parsed = JSON.parse(raw) as Partial<OnboardingState>;
    if (!isOnboardingStatus(parsed.status)) return DEFAULT_STATE;
    return {
      status: parsed.status,
      lastStep: typeof parsed.lastStep === 'number' ? parsed.lastStep : 1,
      completedAt: typeof parsed.completedAt === 'string' ? parsed.completedAt : null,
      completedBy: typeof parsed.completedBy === 'string' ? parsed.completedBy : null,
    };
  } catch {
    return DEFAULT_STATE;
  }
}

export async function setOnboardingState(patch: Partial<OnboardingState>): Promise<OnboardingState> {
  const next = { ...(await getOnboardingState()), ...patch };
  await setMeta(META_KEY, JSON.stringify(next));
  return next;
}

export async function isOnboardingPending(): Promise<boolean> {
  return (await getOnboardingState()).status === 'pending';
}
