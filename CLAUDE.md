# CLAUDE.md

This file provides guidance to AI coding agents (Claude Code, Codex, and others that read
`AGENTS.md` or `CLAUDE.md`) working in this repository. `AGENTS.md` in this repo is just `@CLAUDE.md`;
this file is the one to read.

## The product in one paragraph

RuleBeat runs the governance checks a platform team writes for Azure on a schedule, tracks every
finding over time, and never holds write access. It never blocks a deployment. Every check is a
**rule** (a row in SQLite) that either compiles to an Azure Resource Graph KQL query or targets
Microsoft Graph directly for checks about the directory itself; every result the query returns is a
finding. Users author their own rules through a visual builder that reads and writes KQL both ways,
or as a raw query. A finding shows the rule's own recommendation text; RuleBeat does not generate or
run fixes. It is self-hosted by the customer, in their own Azure, in a Docker container.

## Commands

Windows host, PowerShell. Run from the repo root:

```powershell
npm install
npm run build:core     # required before typechecking or running web
npm run typecheck
npm test               # vitest, both packages
```

Plus `npx tsc --noEmit` from `packages/web` if you touched web files.

**All four must pass before a change is considered done.** If you cannot get them green, say so
explicitly and report what fails. Don't describe a change as finished with a red gate.

## Repo layout

```
packages/
├── core/   @rulebeat/core   scanning engine, ARM clients, KQL builder/parser, types
└── web/    @rulebeat/web    Next.js 16 app: product UI + API routes (App Router, React 19, Tailwind 4)
packages/web/data/packs/*.json  committed, version-pinned external rule packs (APRL)
CHANGELOG.md                release history
docs/public/                user-facing docs (start at docs/public/README.md)
docs/engineering/           contributor docs: how changes are made, conventions, codebase map
```

`packages/web` imports `@rulebeat/core` directly through workspace hoisting and consumes its built
`dist/`, so **core must be built before web will typecheck**. Client components cannot import core
types; web re-declares client-facing types in `packages/web/lib/types.ts`.

## Architecture

### Auth & Azure access
- **User auth:** NextAuth.js v5 with Microsoft Entra ID, plus local accounts bootstrapped on first
  run. Every setting an admin can configure lives in the console, not in env vars; env still wins
  where it's set, so a template deployment never sees a setup screen.
- **Azure API calls:** resolved in exactly one place, `packages/web/lib/azure-credential.ts`: env
  vars (federated token → certificate → client secret) → the credential an admin entered in the UI →
  `DefaultAzureCredential` (managed identity in Azure, `az login` locally). Env constructs a
  *specific* credential rather than letting the chain rediscover the same variables, so a
  misconfigured service principal fails loudly instead of silently scanning under the developer's
  local identity. Never uses the user's OAuth token, never holds write credentials.
  `createTenantContext()` is what every scan/schema/KQL path calls.
- **Route protection:** `proxy.ts` (Next.js 16's rename of `middleware.ts`) guards all routes except
  `/signin` and `/api/auth/*`.
- **RBAC:** three roles (`viewer|editor|admin`) in a local `users` table. Every API handler calls
  `requireRole(action)` (`lib/api-auth.ts`), GETs included, so a removed user loses read access
  immediately. **The role is never on the session token**; it's read from SQLite per request, so a
  demotion takes effect on the next request. Routes name the *action* (`'rules:write'`), never a role
  rank; `lib/rbac.ts`'s `can(role, action)` map is the one place the mapping lives.
- **Audit log:** written at the API route layer, never the repository layer. Records a human summary
  plus changed field *names*, never values.
- **Error responses:** a caught Azure SDK error never reaches the browser; `lib/api-error.ts`'s
  `serverError()` logs it and returns a stable message. Only user-actionable errors (a KQL syntax
  error) are returned in full.

### Scan flow
Browser → `RunScanButton` → `POST /api/scans/run` → `runManualTarget()` → `executeTarget()`
(`lib/run-executor.ts`) → per touched category, `runCategoryScan(category, opts)`
(`lib/scan-runner.ts`) → `runRules()` or `runGraphRules()` from core, by `Rule.queryBackend` → `ScanSummary`,
saved via `saveScanResult()`, then `syncScanFindings()` upserts the `findings` lifecycle table.
Renders in the single `/scans` page's Results tab; category is a filter, not a route.

**Per-rule outcome, not a bare finding list:** `runRules()` is an async generator yielding
`{ kind: 'finding', finding }` and `{ kind: 'outcome', outcome: { ruleId, status, findingCount } }`
events, `status` one of `success | failed | capped | invalid`. A rule whose query throws yields `failed`; one
whose query (or a follow-up page) came back truncated, or whose KQL has a top-level `take`/`limit`,
yields `capped`; either way its findings are real but not exhaustive, so `syncScanFindings()`
(`lib/scan-history.ts`) only resolves a rule's prior findings when that rule's own outcome was
`success`. `scan-runner.ts` collects every non-`success` outcome into `incompleteRules` and sets
`ScanSummary.coverage` to `'partial'` whenever the list is non-empty, surfaced as a badge in Run
History and per-category in the coverage-freshness dashboard widget, never silently folded into
the posture number.

**Rule-first, backend-partitioned:** `runCategoryScan` is the single shared execution path for both
manual scans and scheduled runs, and does not special-case by category. Each category's enabled
rules are partitioned by `Rule.queryBackend`: `microsoft-graph` rules run through `runGraphRules()`
(`packages/core/src/engine/graph-runner.ts`), a separate engine from `runRules()`/Resource Graph
rather than a branch inside it; everything else runs through `runRules()`/Resource Graph. Both feed
the same `totalRules`/`incompleteRules`/`coverage` accounting, so a Graph-side failure marks only its
own rules incomplete rather than aborting the whole scan. Identity's two built-in checks (expiring
app secrets and certificates) are ordinary `microsoft-graph`-backend rules, not a special case, and
flow through the same Results/Run History/Rules tabs as every other category.

**Query-native evaluation:** no in-memory rule evaluation; conditions compile to violation
`| where` clauses, every row the query returns is a finding.

### Rule engine (packages/core/src/engine/)
- `types.ts`: `Rule`/`Condition`/`RuleScope`/`RuleType`. `RuleType` = `'builtin'|'community'|'custom'`;
  `Rule.pack` is the open-ended sub-classification within `type:'builtin'` (e.g.
  `rulebeat-core`/`aprl-v2`). `Rule.id` is a plain UUID for every rule; provenance lives entirely in
  `type`/`pack`. `Rule.queryBackend: 'resource-graph' | 'microsoft-graph' | 'log-analytics'` now picks
  the execution path, and `Rule.shape: 'detect' | 'assert'` plus `Rule.kind: 'state' | 'activity'`
  classify what the rule means, with `kind` always derived from `queryBackend`. `resource-graph` and
  `microsoft-graph` are both authorable through the rule form today; Logs authoring is future work.
- `kql.ts`: `buildRuleQuery`/`buildQueryFromVisual`/`parseKqlToVisualQuery`, the KQL↔GUI parser.
  `normalizeKqlExpr()` pre-normalizes real-world KQL (double-quoted strings, `<>`, etc.) so hand-written
  queries map onto the visual builder. **The parser never loses input.** What it can't map becomes a
  passthrough condition (`operator: 'raw'` + `rawExpr`, read-only in the builder, re-emitted
  verbatim), and `parseWritableCondition()` rejects any parse `visualConditionToKql` can't write back,
  since a parse the generator can't re-emit would otherwise silently vanish at generation time.
- `runner.ts`: `runRules(rules, ctx)`, the Resource Graph engine: an async generator
  (`AsyncIterable<RuleRunEvent<Finding>>`) using `rule.rawKql ?? buildRuleQuery(rule)`. `rawKql`
  rules that don't project `type`/`location`/`resourceGroup`/`subscriptionId` get them backfilled:
  `parseResourceId()` recovers three of them free from the ARM id string; `location` comes from one
  follow-up query, never by rewriting the rule's own KQL. Each rule ends with exactly one `outcome`
  event, and a thrown query error is caught per-rule so one bad rule never aborts the generator for
  the rest.
- `graph-runner.ts`: `runGraphRules(rules, ctx)`, the same contract for `microsoft-graph` rules. A
  separate file rather than a branch inside `runner.ts`, since Graph rules share none of Resource
  Graph's ARM-shaped assumptions (no `parseResourceId()`, no location backfill). Each rule's Graph
  call has its own try/catch, so one rule's failure can't take its siblings down.

Sub-path export `@rulebeat/core/kql` is the client-safe re-export (no Node SDK deps); web re-exports
via `lib/kql.ts`. Rules live in SQLite (`lib/rules.ts` repository layer); built-ins
(`lib/builtin-rules.ts`) seed via `INSERT OR IGNORE`; users can edit/disable but not overwrite.

### ARM schema clients (packages/core/src/clients/)
- `resource-graph.ts`: `ResourceGraphClient` wrapping the Azure Resource Graph SDK
- `resource-schema.ts`: `getResourceTypeFields`/`getAllResourceTypes`, the same ARM provider-aliases
  source Azure Policy uses

### Schema cache (packages/web/lib/schema-cache.ts)
File cache in `data/schemas/` (gitignored): 7d TTL for property schemas, 1d for the type list. Serves
stale-while-refresh; only hits ARM on a true miss.

### Page structure (Next.js App Router)
Server/client split everywhere `auth()` is needed: `page.tsx` (server, calls `auth()` + loads data) +
`*-client.tsx` (client, all interactivity).

### Design system: "Grid"
Swiss/International style: a strict modular grid, hard corners everywhere (`--radius: 0px`), red only
where something is genuinely wrong. The vertical sidebar is the navigation and does not change.

- **Colour only ever comes from the semantic tokens in `packages/web/app/globals.css`.** Never write
  a Tailwind palette class (`text-slate-600`) and never a hex literal; neither flips between light
  and dark. The only exceptions are the Microsoft brand logo and category identity swatches.
- **The primary action is ink; the accent red belongs to problems.** `--primary` and `--destructive`
  must never be the same token.
- **Severity is one hot-to-neutral ramp** (red, burnt orange, ochre, grey) reinforced by font weight.
  Black belongs to type and hairlines, never to a chart or a bar fill.
- **Separation is by ground, not by outline.** Panels sit on a sunken canvas; small repeating
  elements (chips, tags, pills) are soft fills with no border. A line survives only where it does
  structural work.
- **A panel title is `title-grid` (sentence case). `label-grid` (uppercase letterspaced mono) is for
  metadata only**: captions, table column headers, form labels, nav eyebrows.
- **Never use text below 12px.** `text-xs` is the floor. `label-grid`/`label-grid-strong` (11px)
  are the one named exception, enforced by an architecture test's type-floor allowlist.
- Recharts takes neither Tailwind classes for SVG paint nor theme colour for its own chrome. Use
  `fill`/`stroke="var(--color-…)"` and the shared constants in
  `components/dashboard/dashboard-constants.ts`.
- There is **exactly one scroll region**, in `app/(app)/layout.tsx`. Prefer page scroll over an inner
  `max-h` box.

### External pack seeding
`data/packs/*.json` are committed, version-pinned external rule packs. `seedPackPolicies()`
(`lib/db/client.ts`) seeds them as `type=builtin` on startup via `INSERT OR IGNORE` + `UPDATE`. Adding
a pack is dropping a JSON file, no code change.

### Scans page pattern
One page, no category routing; category is a filter like tags/severity/status. `scans/page.tsx`
reads `?tab=`/`?category=`/etc. and renders `ScansClient` once; Results/Run History/Rules tabs each
own their own category filtering internally.

### Scheduled scans
In-process scheduler (`lib/scheduler.ts`, 30s `setInterval`, no external cron/service) polls due
`schedules` rows, busy-flag serialized (shared with manual "Run now"). Recurrence is a hand-written
date-math engine (`computeNextRun()` in `lib/db/schedules.ts`), not cron.
`lib/run-executor.ts`'s `executeTarget()` is the shared core for both manual and scheduled runs.

### Dashboards
Read live posture from the `findings` lifecycle table (not scan-blob history) plus a daily
`posture_snapshots` table for trend history (each row tagged with the formula version that
produced it, so a baseline never blends two formulas).
- **Filters:** `WidgetFilters` (`lib/dashboard-filters.ts`) is the shared shape;
  `mergeWidgetFilters()` has per-widget values **replace, never intersect**, the dashboard-level
  filter. `dateWindow` (`lib/date-window.ts`) resolves to concrete dates at query time, not save
  time, so a saved "7d" preset stays rolling.
- **Unavailable vs. empty:** every widget fetches through `useWidgetFetch`, which wraps
  `fetchJson()`'s `FetchResult<T>` union; a failed fetch renders the shared `WidgetUnavailable`
  component, never the widget's own "no data" copy.
- **`/scans` deep links:** `scans/page.tsx`'s `searchParams` and
  `findings-explorer-client.tsx`'s URL-sync effect must stay symmetric; a change to one without the
  other breaks deep-linking silently.

## Hard rules

These are not style preferences. Get them wrong and the change should be rejected in review.

They are the short version. The full set lives in `docs/engineering/conventions/`, one file per
topic, each rule written after something actually broke. Read every topic file that matches what you
are touching, not just the closest one: a form on a settings page is `ui.md` and `design-system.md`
and usually `auth-security.md`.

### Testing
- **A failing test means the code is wrong.** Never make a test pass by weakening its assertion. If
  you believe the test's assumption is wrong, say so explicitly rather than quietly relaxing it.
- **A feature arrives with its tests in the same change**, not as a follow-up.
- **Every new test must be seen failing once.** Break the code deliberately, watch it go red, put it
  back. A test that cannot fail is worse than no test, because it looks like coverage.
- **A known-but-unfixed bug gets `it.fails()`**, never a `skip` and never a softened assertion.
  `it.fails` asserts the test currently fails, so fixing the bug forces the marker's removal.
- **Test the contract, not the implementation.** For the KQL engine specifically the contract is:
  whatever the builder generates, the parser parses back, and regenerating does not change the query.
- **No live Azure or Microsoft Graph calls in tests.** `TenantContext` is an injectable parameter
  (`runRules(rules, ctx)`, `runCategoryScan(cat, { ctx })`); use `tests/helpers/fake-azure.ts`.
- Tests never touch the real database. `tests/setup.ts` points `RULEBEAT_DB_PATH` at a temp file
  before any repository module is imported. That env var exists for tests only.
- **Assert through the code under test, not beside it.** A test that re-implements the assertion
  logic in its own body proves the standard library works, not that the product does.

### Security and Azure access
- **RuleBeat never holds standing write credentials, and never creates its own service principal or
  assigns its own roles.** It reads; the user fixes. There is no remediation engine and no embedded
  write terminal. Privilege elevation (PIM/PAM) is a hard no.
- **Never return a raw Azure SDK error to the browser.** It can leak tenant ids, subscription ids and
  correlation ids. Log server-side and return a stable message via `lib/api-error.ts`.
- **Every API route calls `requireRole(action)`** from `lib/api-auth.ts`, GETs included. Routes name
  the *action*, never a role rank. A structural test in `tests/unit/route-guards.test.ts` fails until
  a new route has its guard.

### Database and migrations
- **An upgrade must never disturb a user's existing configuration or data.** This is the governing
  rule for anything touching `packages/web/lib/db/migrate.ts`.
- Nearly every migration is wrapped in `try { … } catch {}` by design, so "it ran without throwing"
  proves nothing. **Test that content survived**: rules with their KQL, finding ages, dashboards,
  users, suppressions.
- `sqlite.exec()` does not roll back. Wrap any multi-statement table rebuild in
  `sqlite.transaction()`.
- Anything **derived** from an id must be rewritten when that id is. Findings are keyed on
  `sha256(ruleId::resourceId)`, so renaming a rule strands finding history and silently disables
  suppressions.

### User-facing copy
- **No em dashes anywhere in product UI strings or docs.** Plain sentences instead. This applies to
  labels, empty states, error messages, tooltips and every page under `docs/public/`.
- No hedging filler, no rule-of-three adjective lists. Copy must not read as AI-written.
- An empty or unavailable state must say **why**, not render the same "no data yet" message that
  genuinely-empty data would.

## What to be careful with

- **Don't touch the KQL parser/generator contract or `lib/db/migrate.ts` without understanding why
  they're built the way they are.** Both have a history of silent, expensive breakage; read the
  rules above and the surrounding tests before changing either.
- Don't add dependencies without calling it out clearly in the change description.
- Keep changes scoped to what was asked. If you find an adjacent bug, report it rather than folding
  an unrelated fix into the same change.

## Where to look for more

Read these only when the task needs them.

| File | Read it when |
|---|---|
| `docs/engineering/how-changes-are-made.md` | Before starting any change. The two lanes, which one your change is in, and what each one asks of you. |
| `docs/engineering/conventions/README.md` | Before editing code. The cross-cutting rules, plus the index of topic files. Read every one that matches your work. |
| `docs/engineering/codebase-map.md` | You need to find something. Where each file lives and what it is for. |
| `CHANGELOG.md` | Release history: what shipped in each version. |
| `docs/public/README.md` | Index of the user-facing docs: install, permissions, security, and the behaviour pages. |
| `docs/public/how-it-works.md` | The request path and the two rule engines, for anyone touching scan or finding code. |
| `docs/public/posture.md` | Exactly what "X of Y passing" means; read before touching anything that counts findings. |
| `tests/` (both packages) | The test suite is the closest thing this repo has to a QA plan. Read the tests around the area you're touching before writing new ones, so you match the existing contract style rather than the implementation. |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to report a bug, propose a change, or file a security issue. |
