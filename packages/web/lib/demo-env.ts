/**
 * Whether this deployment is running in demo mode, from the environment alone.
 *
 * Edge-safe on purpose: zero imports, and a static `process.env.RULEBEAT_DEMO` read rather than a
 * dynamic `process.env[name]` lookup. Next's edge/proxy bundler only inlines env vars it can see
 * referenced literally at build time — `lib/auth-secret.ts` documents the exact same rule after a
 * dynamic lookup there once caused the proxy to silently mint sessions with the wrong secret. This
 * file has to work inside that same bundle (`proxy.ts`, `auth.config.ts`), so it stays free of
 * anything Node-only.
 *
 * This is one half of demo mode's two-gate switch — see `lib/demo.ts` for the other. The env var
 * alone only redirects which database file `lib/db/client.ts` opens; it does not by itself turn on
 * anonymous access, the read-only kill switch, or the banner. Those additionally require the
 * `demo-mode-v1` stamp written into that database's own `meta` table by the demo generator, so a
 * mis-set environment variable can at worst expose an empty database, never a real tenant's data.
 */
export function isDemoEnv(): boolean {
  return process.env.RULEBEAT_DEMO === '1';
}
