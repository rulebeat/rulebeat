# Lessons: authentication, authorization, credentials and secrets

Read this before touching `auth.ts`, `auth.config.ts`, `proxy.ts`, `lib/api-auth.ts`, `lib/rbac.ts`,
`lib/azure-credential.ts`, `lib/secret-box.ts`, or adding any API route.

---

## Authorization

**An auth guard that only proves a session exists is authentication, not authorization.** Pair the session check with a role check at the same choke point; gate on the identity claim the role lookup needs, or a pre-RBAC token sails through and 401s on every API call.

**Read routes need the role check too, not just mutations.** A removed or demoted user keeps full read access to the whole cloud estate until their token expires if GETs are session-only.

**Never store a permission on the session token when the lookup is a local read.** A SQLite role lookup per request costs microseconds and makes demotion take effect on the next request; caching on the JWT reintroduces a staleness window.

**Guard server-side data loading on the role that *uses* the data, not the role that *manages* the source.** Notification channels are managed by `notifications:manage` but *assigned* by `schedules:write`, so loading with the admin guard silently broke the assignment UI for every non-admin editor.

**A security flag checked in a page layout doesn't reach API routes unless the API's own guard checks it too.** Page-level and API-level authorization run through different code paths, so a check added to one is invisible to the other.

**Built-in-protection API guards must explicitly whitelist every user-controllable field, not just the obvious one.** A guard that only allows toggling `enabled` silently discards a legitimate `tags`/`group` edit from the same PUT.

**The proxy `matcher` decides what never reaches the guard at all, so a mistake in it is invisible to every other auth test.** The route still looks protected in the permission matrix while the real request either 307s or sails through. Pin the matcher itself.

**Excluding a filename from the matcher needs `[.]` and a `$`, not `\.`.** Next strips the backslash while compiling the matcher string, so an escaped dot silently becomes "any character" (`/iconXpng` walks past) and an unanchored entry works as a prefix (`/icon.png/private` too).

**Anything a signed-out client fetches must sit outside the guard.** Tab and touch icons are requested on `/signin` itself, and a Teams or Slack link-preview crawler has no session and never will. Guarded, the preview silently fails rather than being protected.

**`process.env.AUTH_URL` is a runtime mirror of a Settings value, not purely operator configuration.** Write it through `syncAuthUrlMirror()` so a change or a clear takes effect immediately; a write-only-while-empty guard strands the first value until restart.

**A "zero admins exist" bootstrap branch in a sign-in path is often dead code, not a safety net.** If seeding already creates the first admin synchronously at startup (`seedOwnerAccount()`), that branch only ever fires in the abnormal "every admin later removed" state, where it silently duplicates, and weakens, the real recovery path (`RULEBEAT_INITIAL_ADMIN` + restart). Check what already runs before the request that would hit the branch, not just whether the state it checks for is theoretically reachable.

**An unbounded audit write isn't only "this branch runs on every request". It can be state-dependent.** `authorizeLocalAccount()`'s lockout check runs *before* password verification, so once an account crosses the failed-attempt threshold, every further request (not just the one that caused the lockout) hit the write. This is invisible if you only scan for the obvious always-fires cases like unknown-email.

## Azure credentials

**`DefaultAzureCredential` has no credential source inside a container running off-Azure:** no Managed Identity, no `az login`. Document every path in `.env.example` and make the failure message name the options rather than printing a stack trace.

**When an explicit credential is configured, construct that credential. Don't let `DefaultAzureCredential` rediscover the same variables.** The chain falls through to the developer's `az login` when a service principal is misconfigured, so a broken deployment appears to work locally.

**Never return a raw Azure SDK error to the browser.** It carries tenant/subscription ids, correlation ids, and on credential failures the list of identity sources tried. Log server-side, return a stable message (`lib/api-error.ts`).

**The client-safe-error rule isn't limited to `route.ts` catch blocks. It applies anywhere a caught error's text ends up in a field the client will eventually render.** `run-executor.ts` stored raw `String(err)` in `schedule_runs.error`, a DB column with no route in between to sanitize it before Run History renders it directly.

## Input handling

**An uncaught `req.json()` on malformed input is a 500, not a 400.** `parseJsonBody()` (`lib/api-body.ts`) gives every mutating route the same `instanceof NextResponse` short-circuit convention `requireRole` already uses, so a client typo never looks like a server crash.

## Secrets

**Encrypting a secret at rest does not stop it living with the running process.** Encryption only protects the database when it travels away from its key (backups, `docker cp`); a credential type with no secret is the real answer.

**Trim any secret read from a mounted file.** `echo "secret" > file` appends a newline; Entra rejects the value and the error says only "invalid client secret," sending people to the app registration rather than the trailing byte.

**A JWT-embedded permission check is useless if only API routes enforce it.** `getCurrentUser()` returning `null` on a stale/invalidated session did nothing for page loads until `app/(app)/layout.tsx` got its own `if (!user) redirect('/signin')`. Server-rendered pages and API routes are separate enforcement points that must each be wired, even when they call the same function.

**When adding a new JWT claim to an existing session scheme, treat "claim absent" as equal to the column's default, never as a forced mismatch.** `(session.user.epoch ?? 0) !== dbUser.sessionEpoch` lets every pre-upgrade token (which predates the claim entirely) keep working instead of mass-logging-out the whole install the moment the claim ships.

## NextAuth specifics

**Two NextAuth instances built from a shared config object must be proven to share the same resolved secret.** They can end up in different bundles that each independently resolve env-dependent values, and a silent mismatch fails as an infinite redirect to sign-in with nothing in any log.

**A `Credentials()` provider's built object doesn't reliably expose the raw `authorize` function for direct unit testing.** NextAuth wraps it internally. Export the function separately and test that.

**A leftover `next-auth` session cookie surviving a demo-database rebuild silently 401s every widget fetch, rendering as "no data" rather than an error.** The cookie's `uid` no longer matches any row in the freshly regenerated `demo.db`; a cookie-less request (curl, private window) works fine. Diagnose via the dev server's request log (401s on `/api/widgets/*`), not by re-checking the data.
