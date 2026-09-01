export async function register() {
  // Only run in the Node.js server runtime, not Edge
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // `trustHost: true` (auth.config.ts) means Auth.js will infer the public URL from request
  // headers if nothing else is set — fine for a single-tenant self-hosted app, but a public URL
  // configured in Settings → Sign-in is a stronger source of truth, and Auth.js reads it from
  // `AUTH_URL`. Mirror it once here, at boot, never inside the per-request auth config factory.
  // `syncAuthUrlMirror` is the same call the save handler makes, and is a no-op if the operator
  // set AUTH_URL themselves, so env still wins. Importing the module is what captures the
  // operator's own value, so this must stay the first thing that touches it.
  try {
    const { getPublicUrl, syncAuthUrlMirror } = await import('./lib/sign-in-config');
    syncAuthUrlMirror(getPublicUrl());
  } catch (err) {
    console.error('[startup] could not read the configured public URL:', err);
  }

  const { warmSchemaCache } = await import('./lib/schema-warmer');

  // Warm on startup — non-blocking
  void warmSchemaCache();

  // Refresh daily (24h) — keeps the 7-day TTL cache always fresh
  setInterval(() => { void warmSchemaCache(); }, 24 * 60 * 60 * 1000);

  // Both reconstruct history for an install upgrading from a version that predated these tables.
  // Guarded because they are best-effort approximations of the past: worth attempting, never worth
  // preventing the app from starting. Logged rather than swallowed — silently empty history looks
  // identical to a customer who genuinely had none.
  try {
    const { backfillFindings } = await import('./lib/db/findings');
    await backfillFindings();
  } catch (err) {
    console.error('[startup] finding-history backfill failed:', err);
  }

  try {
    const { backfillSnapshots } = await import('./lib/db/snapshots');
    backfillSnapshots();
  } catch (err) {
    console.error('[startup] trend-history backfill failed:', err);
  }

  // Two-pass crash recovery (spec 025). Pass 1 must run before pass 2: it can hand pass 2 rows it
  // just recovered ('running' -> 'error' with notifyStatus set to 'pending'), not only rows a live
  // run left pending before the crash.
  try {
    const { recoverInterruptedRuns } = await import('./lib/startup-recovery');
    recoverInterruptedRuns();
  } catch (err) {
    console.error('[startup] interrupted-run recovery failed:', err);
  }

  try {
    const { recoverPendingNotifications } = await import('./lib/startup-recovery');
    await recoverPendingNotifications();
  } catch (err) {
    console.error('[startup] pending-notification recovery failed:', err);
  }

  const { startScheduler } = await import('./lib/scheduler');
  startScheduler();
}
