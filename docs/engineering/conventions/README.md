# Engineering conventions

Rules this codebase has learned the hard way. Every entry here was written after something broke,
not before, so each one is a real defect's postmortem compressed into a sentence or two.

If you are contributing, read the topic file that matches what you are touching. Read all of them
that match, not just the closest one: a form on a settings page is `ui.md` *and* `design-system.md`
*and* usually `auth-security.md`.

**This file holds only the cross-cutting rules**, the ones that apply no matter what you are
working on. Everything topic-specific is below.

| File | Read it before |
|---|---|
| [kql.md](kql.md) | Touching the KQL builder, parser, runner, or any Resource Graph query. |
| [data.md](data.md) | Any migration, seed, upsert, external pack sync, or data-model change. |
| [ui.md](ui.md) | Building or changing a React component: state, layout, tables, dropdowns, scrolling. |
| [design-system.md](design-system.md) | Any visual change: colour, type, severity, charts, borders. |
| [auth-security.md](auth-security.md) | Auth, RBAC, API route guards, Azure credentials, secrets. |
| [platform.md](platform.md) | Next.js, TypeScript, Docker, the test runner, or the dev loop. |
| [content.md](content.md) | Writing anything a user reads: UI strings, docs, README, public claims. |
| [releases.md](releases.md) | Cutting a release, `CHANGELOG.md`, or anything under `scripts/release*` and the release workflows. |

See also [`../codebase-map.md`](../codebase-map.md) for where things live, and
[`../how-changes-are-made.md`](../how-changes-are-made.md) for how a change gets from idea to merge.

**Adding a lesson:** put it in the topic file it belongs to. It only belongs in this file if it
would change how you work on a task in a *different* area. Keep it to about two lines: one bold
sentence (the rule), one short clause (the why). No code blocks. Merge near-duplicates rather than
appending.

---

## Verifying and testing

**Assert through the code under test, not beside it.** A test that re-implements the assertion logic in its own body verifies that the standard library works, not that your code does.

**A known-but-unfixed bug gets `it.fails()`, never a `skip` and never a softened assertion.** `it.fails` asserts the test currently fails, so fixing the bug forces the marker's removal.

**Any pair that converts back and forth must be tested for *stability*, not just correctness.** Assert that applying it twice equals applying it once. A round trip that rewrites its input slightly each cycle corrupts the record progressively.

**Assert that the user's data survived, never that the code "ran without error."** Anything wrapped in `try { … } catch {}` by design (migrations, backfills, seeds, one-time upgrades) swallows its own failure, so the only honest assertion is that the rows and their values are still there afterwards.

**Verify a change against real committed data, not only its unit tests.** Running it across the repo's own fixtures and counting what drifts finds blockers that hand-written cases miss.

**An architecture test that reads source files off disk enforces conventions the type system can't.** Always assert the sweep found something (`expect(files.length).toBeGreaterThan(20)`), or the test passes by testing nothing.

**Do not log a bug whose mechanism you could not reproduce.** A build failure blamed on parallel workers racing the import-time DB seeding survived zero of four controlled reproductions; a bug-log entry asserting an unverified cause is worse than no entry, because the next person debugs the fiction.

## Before you trust something

**Grep a component's usages before assuming a fix to it covers the surface you tested.** Two components rendering the same entity is the norm here, and the inline copy is always the stale one. `findings-table.tsx` is only used by Run History, while the main Results tab renders its own panel.

**Rendering a shared control does not prove its consumers use its output.** Widgets can show the full filter picker, save fine, and silently ignore the result, so check each consuming component's fetch call, not just that the panel renders.

**A documented config escape hatch can have no working write path at all.** Grep for the setter's actual call sites, not just its existence, before trusting a comment that calls something configurable.

**Before assuming a conflict blocks a feature, check what the relevant fields actually capture at write time.** A dimension marked "unsupported" turned out to already be stored: joining `finding_events` to `findings` on fingerprint recovered subscription/RG/severity filters for free.

**Fetch a public asset as the client that will really fetch it, not as your signed-in self.** The OG card and tab icons were all behind the auth guard and looked perfect in the page source. An unauthenticated `curl` was the only thing that saw the redirect.

**Prior art validated for one decision does not transfer to the adjacent one.** Research answers the question it was aimed at, so re-read whether a finding actually covers the question now being asked before applying it.

## Structural rules that cost the most when broken

**Anything derived from an id must be rewritten when that id is.** Findings are keyed on `sha256(ruleId::resourceId)`, so renaming a rule silently strands every finding's history and switches off every suppression. Grep for every value *computed from* the thing being renamed.

**Anything resolvable from more than one source needs one construction site, enforced by an architecture test.** Nine call sites each building their own Azure credential was invisible breakage the moment there were three auth sources. Ban the constructor everywhere else and assert the one allowed file still uses it.

**`TenantContext` being a plain parameter is why the scan pipeline is testable with no Azure account.** Worth preserving deliberately: the moment a call site reaches for the credential directly instead of taking a context, that property is gone.

**When a value a function needs is already sitting on an injected context, re-deriving it via a fresh SDK call defeats the injection.** Check what the context already carries before adding a second live call for the same fact.

**A new execution backend gets its own engine, not a branch inside the shared one.** `graph-runner.ts` staying separate from `runner.ts` kept ARG's ARM-shaped assumptions off a backend that doesn't share them, and made per-rule failure isolation a property of the engine itself rather than a branch someone could forget to wrap.

**User-facing copy must not read as AI-written.** No em dashes joining clauses, no hedging filler, no rule-of-three adjective lists. Don't default a status indicator to a permanently-visible colored box for the normal case. Reserve full callouts for problems or actionable detail.
