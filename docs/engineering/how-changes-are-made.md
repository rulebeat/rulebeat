# How changes are made

This describes what RuleBeat asks of a change before it lands. It is short on purpose. If you are
opening your first pull request, this and [`conventions/README.md`](conventions/README.md) are the
two pages worth reading first.

The reason this exists at all: the expensive mistakes in this project were never typing mistakes.
The design system was built and partly reversed inside a day. The severity scale was designed twice.
Six upgrade bugs were found only after somebody wrote a test suite specifically to look for them.
None of those were coding failures. They were decisions that went into code before anyone wrote them
down and attacked them.

---

## Two lanes

Which lane a change is in is decided by **the files it touches**, not by how big it feels. Effort is
deliberately not part of the test, because effort is the judgment that collapses first under
impatience. A one-line fix to the permissions map is still a design change.

### Lane A: write the plan first

A change is Lane A if it touches **any** of these:

| Surface | Paths |
|---|---|
| Rule engine | `packages/core/src/engine/**` |
| Database shape | `packages/web/lib/db/migrate.ts`, any new table, column, or stored shape |
| Auth and access | `auth.ts`, `auth.config.ts`, `proxy.ts`, `lib/api-auth.ts`, `lib/rbac.ts`, `lib/azure-credential.ts`, `lib/secret-box.ts` |
| Design tokens | `packages/web/app/globals.css`, or the shared UI primitives in `components/ui/**` |
| Product shape | A new page, a new widget, a new setting, or any change to what a user sees or does |

For these, open an issue describing the plan before writing code, and say four things in it:

1. **The problem**, and who it hurts. Not the solution.
2. **What done looks like**, concretely enough that someone else could tell whether you got there.
3. **What you are explicitly not touching.** This line does more work than the other three combined.
4. **What you considered and rejected**, and why.

Then let it be argued with before it becomes a diff. A plan that nobody disagreed with has usually
not been read.

Lane B work that turns out to touch a Lane A path becomes Lane A at that moment, before the edit,
not after.

### Lane B: everything else

A typo, a copy fix, a one-file bug with an obvious cause, a test, a doc. No plan document needed.
State the frame in the pull request in about four lines (what is wrong, what done looks like, what
you are not touching) and build it.

---

## Building

- **Start by re-reading the plan**, and record any deviation from it rather than making it silently.
  A plan that quietly stopped matching the code is worse than no plan, because the next person
  believes it.
- **Tests go in the same commit as the code**, not a follow-up.
- **Name the issue in the commit message.**

## Testing rules

These are not negotiable, and they are the rules the whole suite's value rests on.

- **A failing test means the code is wrong.** Never make a test pass by weakening its assertion. If
  the test's *assumption* was wrong, say so explicitly and get agreement before changing it. Do not
  quietly relax it.
- **Every new test must be seen failing once.** Break the code deliberately, watch it go red, put it
  back. A test that cannot fail is worse than no test, because it looks like coverage.
- **A known but unfixed bug gets `it.fails()`**, never a `skip` and never a softened assertion.
  `it.fails` asserts that the test currently fails, so fixing the bug forces the marker's removal.
- **Test the contract, not the implementation.** Assert on behaviour that survives refactoring. For
  the rule engine specifically, the contract is: whatever the builder generates, the parser parses
  back, and regenerating does not change the query.
- **No live Azure or Graph calls in tests.** `TenantContext` is injectable, so use the fake in
  `tests/helpers/fake-azure.ts`. A test that fails when Azure is slow trains you to ignore red.
- **Every bug found by hand becomes an automated test before it is closed.** This is what stops a
  manual checklist growing until nobody runs it.
- Tests never touch a real database. `tests/setup.ts` points `RULEBEAT_DB_PATH` at a temp file
  before any repository is imported.
- Adding an API route? A structural test fails until that route calls `requireRole`. That is
  intentional. Add the guard rather than an exception.

## Deciding whether a merge needs a release

A release is not tied to a merge or a PR. Several merges can sit unreleased in
`CHANGELOG.md`'s `[Unreleased]` section until it's worth publishing a new version; a release
happens when someone decides it's time to publish a new Docker image, not automatically.

**Does the version number move at all?**

- **Docs-only change** (a page under `docs/public/`, the `README`, code comments): no version
  bump. Nothing the running app does changed, so there's nothing to redeploy or for
  `getAppVersion()` to report differently.
- **Anything that changes what the running app does** (a fix, a new setting, a new page, a
  schema change): gets a version bump when it's next released, at whatever level below applies.

**If it does move, which level:**

| Bump | When | Example from this repo |
|---|---|---|
| **patch** (`0.1.0` → `0.1.1`) | A fix, with no new capability | The `?signin=test1` gate removal, a copy fix |
| **minor** (`0.1.0` → `0.2.0`) | A new capability, nothing existing breaks | The reuse-Azure-connection checkbox |
| **major** (`1.x.0` → `2.0.0`) | Something requires the user to act (a migration, a removed setting) | Not applicable yet, pre-1.0 |

Pre-1.0 (`0.x.y`), semver technically allows anything to break at any bump, but the table above
is how this project actually uses the three levels in practice, and that's worth keeping even
before `1.0.0`.

The `[Unreleased]` section in `CHANGELOG.md` is the running record: every PR that changes app
behaviour adds a line there (Added / Changed / Fixed) as part of the same commit, whether or not
a release follows right away. When someone decides to cut a release, the bump level is read
straight off what's accumulated there.

**What a merge to `main` actually publishes, docs-only included:** `ci.yml` builds and pushes a
Docker image on every push to `main`, tagged only by commit (`ghcr.io/.../rulebeat:sha-<commit>`).
That happens unconditionally, docs-only changes included, because CI needs a real image to run
the Docker smoke test against either way. But nobody pulls an image by commit SHA. `:latest` and
any version tag (`:0.1.1`) only move when `publish-image.yml` runs, and that workflow only fires
on a pushed `vX.Y.Z` tag, i.e. only after `npm run release` and a deliberate `git push origin
vX.Y.Z`. So a docs-only merge leaves an unreferenced `sha-<commit>` image sitting in the registry,
doesn't move `:latest`, and doesn't change what `getAppVersion()` reports — it just waits in
`[Unreleased]` until the next real release bundles it in.

## Cutting a release

Two GitHub Actions stages, run from the Actions tab, so tagging a release is never a step someone
has to remember to do correctly from a local checkout — and so the actual diff gets reviewed
before anything is published, not just the decision to release.

1. **Prepare release** (`workflow_dispatch`, pick `patch`/`minor`/`major`). Runs
   `scripts/release.mjs` on a throwaway branch — the same script described below — then drops the
   local tag it creates and opens a PR titled `release: vX.Y.Z` instead of pushing anything
   further. Nothing is tagged or published at this point.
2. Review that PR like any other: the whole diff is the version bump plus the `CHANGELOG.md`
   reshuffle, nothing else. **Merging it is the approval** — ordinary PR review, gated by whatever
   branch protection `main` already has.
3. **Tag release** picks up the merge automatically, re-verifies `package.json`/`CHANGELOG.md`
   agree with each other, then creates and pushes the `vX.Y.Z` tag. Pushing that tag is what
   starts `publish-image.yml` (see below) — this workflow never builds or publishes an image
   itself, only tags.

Under the hood, `npm run release -- <patch|minor|major>` (`scripts/release.mjs`) is what stage 1
actually runs: it bumps `package.json` in the root and both packages to the same new version,
resyncs `package-lock.json` against them, moves `CHANGELOG.md`'s `[Unreleased]` section under a
new dated header, and commits all five files together. It refuses outright on a dirty working tree
or an empty `[Unreleased]` section, and changes nothing when it refuses. It can still be run
locally the same way if the two-stage workflow is ever unavailable — review the commit
(`git show HEAD`), then `git push && git push origin vX.Y.Z` yourself, same as stage 3 above does.

Either way, pushing the tag is what starts `publish-image.yml`, which itself refuses to promote a
release whose tag disagrees with what `package.json`/`CHANGELOG.md` say — a check that runs
independently of both paths, so it still catches a tag pushed by hand with no script or workflow
involved.

## What this project deliberately does not do

- **No parallel work on one feature.** Review is the bottleneck, not typing. Producing diffs faster
  than anyone can read them makes the bottleneck worse, not better.
- **No new tooling without a reason traceable to a real delay.** The harness is not the product.
- **No enforcement hooks yet.** They are for things people keep forgetting. Nothing has slipped
  repeatedly enough to justify one.

---

## See also

- [`conventions/README.md`](conventions/README.md): the rules this codebase learned the hard way,
  each one written after something broke.
- [`codebase-map.md`](codebase-map.md): where things live.
- [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md): local setup, and how to propose a rule or
  report a bug.
