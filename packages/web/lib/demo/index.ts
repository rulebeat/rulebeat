import { isDemoEnv } from '../demo-env';
import { getMeta, setMeta } from '../db/meta';
import { DEMO_STAMP_KEY } from './stamp';

export { isDemoEnv } from '../demo-env';

export { DEMO_STAMP_KEY, LEGACY_DEMO_STAMP_KEYS } from './stamp';

/**
 * The fixed `users.id` of the seeded viewer row an anonymous visitor browses as in demo mode.
 * A real row, not a synthetic in-memory user — `lib/api-auth.ts`'s `getCurrentUser()` looks it up
 * with the same `getUser()` every signed-in request uses, so nothing downstream needs to know the
 * difference. Only the Demo generator (`./run.ts`) creates this row; the running app only ever reads it.
 */
export const DEMO_VISITOR_ID = 'demo-visitor';

// `isDemoMode()` is called on every guarded request (auth, credential resolution, page gates), so
// the stamp is cached after the first read rather than hitting the database every time. Nothing in
// the product ever removes the stamp once written, so there is no invalidation path to build.
let cachedStamped: boolean | null = null;

/**
 * The full demo-mode gate: the `RULEBEAT_DEMO` environment variable (which already redirected
 * `lib/db/client.ts` to `demo.db` before this function could even query it) **and** the
 * `demo-mode-v2` stamp in that same database.
 *
 * Both are required, deliberately. The env var alone would turn on anonymous read-only access and
 * the "you can't write here" kill switch against a database that was never actually populated by
 * the generator — every empty `demo.db` some other process happened to create would look live. The
 * stamp alone is inert, because nothing reachable without the env var ever checks it. Neither gate
 * is set by anything in the running app; only the Demo generator writes the stamp, and only
 * a deployer sets the environment variable.
 */
export async function isDemoMode(): Promise<boolean> {
  if (!isDemoEnv()) return false;
  if (cachedStamped !== null) return cachedStamped;
  return (cachedStamped = (await getMeta(DEMO_STAMP_KEY)) !== null);
}

/** Called by the generator once the synthetic estate is fully written — never by the running app. */
export async function stampDemoDatabase(): Promise<void> {
  await setMeta(DEMO_STAMP_KEY, '1');
  cachedStamped = null;
}

/** Test seam: forget the cached stamp so a test can flip demo mode mid-run. */
export function resetDemoModeCacheForTests(): void {
  cachedStamped = null;
}
