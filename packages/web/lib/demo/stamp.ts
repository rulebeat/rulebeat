// No imports on purpose: lib/demo/boot.ts reads these before lib/db/client.ts may open anything.

/** Written into the demo database's `meta` table once the synthetic data generator has finished
 *  populating it. Its presence is the second gate — see `lib/demo-env.ts` for the first. */
export const DEMO_STAMP_KEY = 'demo-mode-v2';

/** Stamps written by earlier releases. A database carrying one is a demo database from before the
 *  Demo was writable, so the boot step may replace it; it never turns the Demo on by itself. */
export const LEGACY_DEMO_STAMP_KEYS = ['demo-mode-v1'] as const;
