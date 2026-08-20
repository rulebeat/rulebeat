import { mulberry32, pick, pickWeighted, rand01 } from './prng';

const IDENTITY_SEED = 0xbadA55;
const APP_COUNT = 28;

const APP_WORDS = [
  'checkout-api', 'billing-service', 'internal-portal', 'data-pipeline', 'reporting-tool',
  'mobile-backend', 'partner-integration', 'auth-gateway', 'notification-service', 'search-indexer',
  'analytics-worker', 'legacy-sync', 'vendor-connector', 'ci-deploy-bot', 'support-console',
];

interface SyntheticCredential {
  keyId: string;
  displayName: string;
  /** Days-remaining this credential will show on the *final* simulated day (today). Negative means
   *  already expired by then. Values above 30 never surface as a finding (the widest band on the
   *  real `cred:app-secret-expiring`/`cred:app-cert-expiring` rules' `graphQuery.expand.bands` in
   *  lib/builtin-rules.ts) — kept in the pool anyway so not every app has an alert, which would
   *  look fake. */
  offsetFromEnd: number;
}

export interface SyntheticApp {
  id: string;
  displayName: string;
  appId: string;
  secrets: SyntheticCredential[];
  certs: SyntheticCredential[];
}

const OFFSET_WEIGHTS: Array<{ value: number; weight: number }> = [
  { value: -10, weight: 3 }, // already expired, steady critical
  { value: 3, weight: 4 }, // critical, about to expire
  { value: 10, weight: 5 }, // high
  { value: 22, weight: 6 }, // medium
  { value: 60, weight: 10 }, // healthy — never crosses the 30-day window
  { value: 120, weight: 12 }, // healthy, plenty of runway
];

function buildCredential(seedKey: string, index: number, kind: 'secret' | 'cert', rng: () => number): SyntheticCredential {
  return {
    keyId: `${seedKey}-${kind}-${index}`,
    displayName: kind === 'secret' ? `${kind} #${index + 1}` : `cert #${index + 1}`,
    offsetFromEnd: pickWeighted(OFFSET_WEIGHTS, rng),
  };
}

/** Built once, deterministically, independent of the simulated day — mirrors `buildEstate()`. */
export function buildIdentityApps(): SyntheticApp[] {
  const rng = mulberry32(IDENTITY_SEED);
  const apps: SyntheticApp[] = [];

  for (let i = 0; i < APP_COUNT; i++) {
    const word = pick(APP_WORDS, rng);
    const id = `00000000-0000-0000-0000-${(100000 + i).toString().padStart(12, '0')}`;
    const appId = `00000000-0000-0000-0000-${(900000 + i).toString().padStart(12, '0')}`;
    const secretCount = rng() < 0.7 ? 1 : 2;
    const certCount = rng() < 0.25 ? 1 : 0;

    apps.push({
      id,
      displayName: `${word}-${i}`,
      appId,
      secrets: Array.from({ length: secretCount }, (_, j) => buildCredential(id, j, 'secret', rng)),
      certs: Array.from({ length: certCount }, (_, j) => buildCredential(id, j, 'cert', rng)),
    });
  }

  return apps;
}

/** A credential eligible for rotation (`offsetFromEnd <= 22`, i.e. it would show as a finding by
 *  the end of the window) rotates around the midpoint of the replay — resolved for the second half.
 *  Computed lazily here (not at buildIdentityApps() time) because it needs `totalDays`, which isn't
 *  known until the replay orchestrator decides how many days to simulate. */
function rotationDay(cred: SyntheticCredential, totalDays: number): number | undefined {
  if (cred.offsetFromEnd > 22) return undefined;
  const roll = rand01(`rotates::${cred.keyId}`);
  if (roll >= 0.25) return undefined;
  return Math.floor(totalDays * (0.4 + rand01(`rotateday::${cred.keyId}`) * 0.35));
}

function endDateTimeFor(cred: SyntheticCredential, day: number, totalDays: number, realNow: number): string {
  const rotateDay = rotationDay(cred, totalDays);
  if (rotateDay !== undefined && day >= rotateDay) {
    return new Date(realNow + 180 * 86_400_000).toISOString();
  }
  const daysRemaining = cred.offsetFromEnd + (totalDays - 1 - day);
  return new Date(realNow + daysRemaining * 86_400_000).toISOString();
}

/** Shapes the synthetic apps into exactly what `runGraphRules()` (packages/core/src/engine/
 *  graph-runner.ts) expects back from `graphGet('/applications?...')`, with every credential's
 *  `endDateTime` computed relative to the real wall-clock "now" (constant across the whole,
 *  short-lived generator run) so that `daysUntil()` — which measures against real `Date.now()` —
 *  comes out to exactly the days-remaining this simulated day should show, with zero changes to
 *  the engine itself. */
export function graphAppsForDay(apps: SyntheticApp[], day: number, totalDays: number) {
  const realNow = Date.now();
  return apps.map(app => ({
    id: app.id,
    displayName: app.displayName,
    appId: app.appId,
    passwordCredentials: app.secrets.map(c => ({
      keyId: c.keyId,
      displayName: c.displayName,
      endDateTime: endDateTimeFor(c, day, totalDays, realNow),
    })),
    keyCredentials: app.certs.map(c => ({
      keyId: c.keyId,
      displayName: c.displayName,
      endDateTime: endDateTimeFor(c, day, totalDays, realNow),
    })),
  }));
}
