# Lessons: Next.js, TypeScript, build, Docker, tests and the dev loop

Read this when the problem is the framework, the toolchain, the container or the test runner rather
than the product.

---

## Next.js

**Any page using an async-`auth()` component must be a server component.** Split into `page.tsx` (server, loads data + auth) + `*-client.tsx` (client, all interactivity).

**Server-render list/nav initial data as a prop from a server-component layout** to eliminate first-paint flash. For persisted UI prefs, use a cookie (readable server-side) not localStorage. Server and client then agree from first paint, with no correction flash.

**A dynamic `process.env[name]` read is invisible to Next's edge/proxy bundler, even though it works fine under plain Node.** Only a literal `process.env.NAME` gets inlined; anything that might load into `proxy.ts`/middleware must read env vars as literals.

**A static route segment always wins over a dynamic one at the same level.** Use this to keep a special-cased route static while making the rest dynamic.

**Deleting a route can leave a stale framework-generated type manifest pointing at the deleted file.** If `tsc` reports a missing-module error for a route you just removed, clear the framework's build cache first.

**Native Node addons (`better-sqlite3`) need `serverExternalPackages` in `next.config.ts`**, and their data directory must exist (`mkdirSync`) before the DB opens.

**`instrumentation.ts`'s `register()` is the right place for server-startup background tasks** (guard `NEXT_RUNTIME === 'nodejs'`, dynamic-import to avoid bundling, don't await the initial call).

**When a dependency's own response is internally inconsistent, fix it at your own boundary rather than patching the dependency.** `proxy.ts` wraps `next-auth`'s handler and rewrites just the inconsistent field to match the part already proven correct.

**`URL.host = 'host'` does not clear a stale port already on the URL when the new value carries none.** Only `.hostname =` does that cleanly, so pair it with an explicit `.port = ''`.

**Next 16 renamed `error.tsx`'s retry callback to `unstable_retry()` (was `reset()`), and `global-error.tsx` must define its own `<html>`/`<body>` since it replaces the root layout entirely.** Both were confirmed by reading `node_modules/next/dist/docs/` directly rather than from memory, since this version diverges from most training data. `global-error.tsx` therefore can't rely on `globals.css` custom properties or font loading being intact, which makes it the one place inline styles and a system font stack are correct.

## TypeScript and packaging

**Client-safe imports from a Node-dependent package need a dedicated sub-path export** (e.g. `@rulebeat/core/kql`) whose entry point avoids Node-only deps.

**`import type` from a server-only module into a client component is safe and erased at compile time.** Don't duplicate the interface in a "client-safe" types file.

**The web `Finding` type has `detectedAt: string`; core's has `detectedAt: Date`.** Any code shared between the two representations must pick one explicitly; import from `@/lib/types` inside `packages/web/`.

**Generic type inference breaks when two parameters can both supply candidates for the same type parameter.** Pin the type parameter explicitly at each call site once a second inference site exists.

**Deriving a type via `Awaited<ReturnType<typeof fn>>` from an overloaded function silently picks the wrong overload.** Import the library's own exported type (e.g. `Session` from `next-auth`) instead of deriving it.

**`globalThis.crypto.randomUUID()` works in both browser and Node ≥19**, which avoids a Node-only `import { randomUUID } from 'crypto'` in code shared with the client.

**`packages/web/lib/kql.ts` consumes `@rulebeat/core/kql`'s built `dist/`, not `src/` directly.** A core-side fix is invisible to any web-side test or the running app until `npm run build:core` runs. Core's own suite imports `src/` directly and goes green immediately, which makes a stale-dist gap easy to miss.

## Tests

**A module that opens a database/file at import time can't be redirected by a test, only by an env var read at that same moment.** Tests need `RULEBEAT_DB_PATH` set in a setup file before the first import, not a mock and not a `beforeEach`.

**Test fixtures should preserve whatever the app seeds at import time, not wipe it.** Clearing seeded tables leaves the DB in a state no real install is ever in; `resetDb()` clears mutable state only.

**Assert a framework's config through the framework's own compiler, never a regex you rewrote by hand.** Next rewrites a proxy `matcher` before using it (escapes dropped, transport suffixes appended); `unstable_doesMiddlewareMatch` from `next/dist/experimental/testing/server/middleware-testing-utils` tests what actually runs.

**Vitest resolves `node_modules` imports through Node's native loader by default, bypassing `resolve.alias` entirely for third-party packages.** A package whose own code needs an alias must be listed in `test.server.deps.inline` so it routes through Vite's resolver instead.

**An auto-seed that writes a real file can't be gated on "are we under the test runner" alone if a legitimate test fixture also needs that same seed to fire.** Gate the *specific unsafe call site* instead.

**A prune-after-insert cap test must assert the count, not which rows survived.** Rapid inserts can land the same millisecond timestamp, so which rows get pruned isn't deterministic. Assert `toHaveLength(N)`, not the identity of surviving rows.

**`node_modules` is hoisted to the repo root, not `packages/web`.** A "that API doesn't exist in this version" conclusion drawn from looking in the package's own folder is wrong before it is interesting. Check the root first.

**`RULEBEAT_DB_PATH` redirects the database but not `DATA_DIR`, which is always `cwd/data`.** Building against a scratch DB with zero users still fires `seedOwnerAccount()`, which overwrites the real `data/initial-password.txt`.

**A doc that names a test file as proof of coverage needs its own architecture test checking that file still exists.** Grep the doc for every backtick-quoted `*.test.ts`/`*.spec.ts` citation and fail the build the moment one stops existing, so a rename can't quietly leave a case marked automated with nothing running it. Such a check can only prove the citation didn't rot, never that the cited test still proves what the doc claims. That part stays a judgment call for whoever edits the doc.

**A regex-based architecture test scanning raw source text can't tell a doc-comment mention from a real call site.** `azure-credential-chokepoint.test.ts` flagged a file that only *named* `buildTenantContext()` in a comment explaining why it isn't called. Fix a false positive like this by rewording the comment, never by weakening the check, since the underlying rule is still real.

**This codebase has no React component-rendering test layer.** Vitest runs `environment: 'node'` in both projects and reserves browser/UI behavior for Playwright e2e; there's no `@testing-library/react`. Logic living inside a component's render body or a `useState` initializer that needs a unit test should be extracted into a plain, importable `lib/` function first. `isVisualQueryStale()` is the worked example.

**A Playwright global teardown must kill the whole spawned process tree, not just the recorded pid.** `shell:true` starts an intermediary shell (cmd.exe on Windows, `/bin/sh` on POSIX) whose child is the real `next start` node process, so killing only the pid leaves that child orphaned and holding the port. Windows: `taskkill /F /T /PID`; POSIX: spawn `detached: true` then signal the negative pid to hit the whole process group.

## Docker and deployment

**A non-root container needs `.next` chowned, not just the data directory.** Next.js writes to `.next/cache` at runtime; chowning only the volume path builds fine and then fails on first request.

**`.dockerignore` must mirror what `.gitignore` actually excludes, not just its intent.** Blanket-excluding a runtime data directory can also exclude committed source files nested inside it (e.g. `data/packs/`), breaking every Docker build silently.

**A closed-source product can still ship a public Docker image from a private repo.** Publish the built image to GHCR, never the source. The first push creates the GHCR package as private by default (it inherits repo visibility); flipping it to public is a one-time manual step in GitHub's package settings, not something the workflow can do for you.

**The container's internal `HOSTNAME=0.0.0.0` and the host's port-publish binding are two different knobs, and only one is safe to widen.** `Dockerfile`'s `ENV HOSTNAME=0.0.0.0` has to stay `0.0.0.0` (it's inside Docker's own network namespace, unreachable from the host either way); the actual host-exposure surface is `docker-compose.yml`'s `ports:` mapping, and *that's* the one that should default to `127.0.0.1:3000:3000` for anything with no TLS story of its own.

**A workspace package left out of `serverExternalPackages` isn't missing from `output: 'standalone'`. It's inlined.** `@rulebeat/core` never appears as a copied `node_modules` entry under standalone output; its compiled code is bundled straight into the server chunks. Prove it by grepping compiled chunk output for the package's real exported symbol names, not by looking for a `node_modules/@rulebeat` directory that was never going to exist.

**`outputFileTracingExcludes` only tunes normal per-route tracing.** It does nothing for the "whole project traced unintentionally" fallback. That fallback triggers on a dynamic `readdirSync`/`readFileSync` the tracer can't statically resolve (e.g. seeding code iterating a data directory) and, once triggered, physically copies the *entire* source tree into `output: 'standalone'`'s output regardless of any exclude glob. If the offending dynamic call lives in a Lane A file you don't want to touch for a build-tooling fix, a `turbopackIgnore` comment hint plus an explicit `rm -rf`-then-recopy in the Dockerfile's runner stage works around it without changing product code.

## Scheduling and caching

**Standard cron can't express "every N weeks" or a recurrence anchored to an arbitrary start date, so write recurrence as closed-form date math instead** (a small bounded scan is only needed for the multi-day-per-period case).

**Treat a cached empty/zero-value result as a cache miss, not a fresh hit.** Otherwise one bad upstream response becomes a permanent dead-end.

## Integrations

**Teams incoming webhooks (O365 connectors) are retired, so use Power Automate Workflows.** The legacy connector format (`*.webhook.office.com`) stopped working in spring 2026; the Adaptive Card payload format for Workflows differs from message cards.

## Logging

**Widen a logging interface with an optional second parameter rather than a new method.** `TenantContext.log(message, fields?)` stayed backward-compatible with every existing test double while giving real callers a structured `{operation, status, durationMs, level}` shape to write.

**A logging hook that exists on the type but is wired to a no-op in the real constructor logs nothing in production, and nothing will fail to tell you.** Check what the real factory function actually passes, not just that the interface has the field.

## Azure/network calls

**An SDK pager reusing one `AbortSignal.timeout()` across its internal pages bounds the whole enumeration, not each page.** Give single-shot calls a fresh per-request timeout and give pager-based calls one explicit, larger operation-wide budget. Conflating the two either times out a legitimate multi-page list or lets a single-shot call hang forever.

## The dev loop itself

**A long-lived dev server session can execute new migration code via hot-reload before you get to test it manually, so verify DB state directly with queries, not just a clean typecheck.** Stale-HMR errors from editing a DB singleton module look like code bugs but a full restart resolves them.

**Stopping a background task kills the wrapper shell but leaves `next dev` running and holding the port.** Next 16 then refuses to start a second dev server in the same directory, which surfaces as a confusing unrelated failure. Kill the node process, not just the task.

**A `{/* … */}` comment placed inside the parenthesised body of `{cond && ( … )}` is a JSX parse error**, and a typecheck run *before* that edit will not catch it. Re-run `tsc` and read the dev server console after editing JSX.

**The Edit tool can silently introduce Unicode smart quotes into JSX, breaking TS with cascading `TS1127` errors.** Replace U+201C/U+201D with plain ASCII quotes via a script.

**Independent per-resource violation odds across hundreds of resources make "zero violators for this rule" statistically impossible, even at low individual rates.** The demo generator's tenant-wide posture stat only counts a rule as passing with zero findings anywhere, so it needed a separate per-*rule* "clean" coin flip, not just per-resource odds, to avoid pinning at 0%.
