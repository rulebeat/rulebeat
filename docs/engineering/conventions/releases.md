# Lessons: cutting a release, and the CHANGELOG

Read this before touching anything under `scripts/release*`, `scripts/check-release-*`,
`scripts/verify-release-*`, `CHANGELOG.md`, or the three release workflows
(`prepare-release.yml`, `tag-release.yml`, `publish-image.yml`).

---

## The order the pipeline runs in

**The release sequence is `validate candidate` then `CI green on the exact merge SHA` then
`create the tag` then `publish`, and that order is load-bearing.** A tag is permanent. Creating one
before its commit has passed CI means a failing release burns a version number: the tag exists,
publishing refuses, and the idempotency rule below correctly will not move it.

**Tag `pull_request.merge_commit_sha`, never `ref: main`.** `main` can advance between the release PR
merging and the runner starting, and tagging whatever it points at then attaches the release to a
commit nobody reviewed as part of it.

**Compare a tag's peeled target, `vX.Y.Z^{}`, never the bare ref.** These are annotated tags, so
`git rev-parse v0.2.0` returns the tag *object* (`54f5a9f`), not the commit (`bd0e77a`). Idempotent
re-tagging that compares the bare ref reads "points elsewhere" on every legitimate re-run and refuses.

**A release contains everything merged into `main` through the release PR's merge SHA.** Product
changes in it were reviewed in their own PRs; the release PR reviews only the version and CHANGELOG
transformation. An unrelated commit inside a release is normal, not a fault. What must contain
nothing but the release files is the release *branch's own* diff against its merge base.

## Identity

**A branch name is not an identity.** `startsWith(head.ref, 'release/v')` is a string anybody can
choose, and a fork can name its branch `release/v9.9.9`. Identity requires the exact
`release/vX.Y.Z` pattern, the same repository, the expected automation author, and a version
matching `package.json`, all together.

**A PR shaped like a release that fails identity must fail loudly, never skip silently.** Silently
skipping it hides exactly the case the check exists for. Ordinary PRs skip; near-misses fail.

**A job-level `if:` cannot call a JavaScript predicate.** The job's condition stays broad and the
first step classifies, then later steps gate on its output.

## Refusing safely

**A refusal must change nothing.** `release.mjs` used to run `npm version`, rewrite both workspace
manifests and regenerate the lockfile before it ever read `CHANGELOG.md`, so an empty `[Unreleased]`
aborted with a half-bumped tree while the docs claimed otherwise. Every mutating step now runs inside
a snapshot that is restored on any failure, including a partway `npm install` failure.

**`[Unreleased]` must be empty at the commit being tagged.** A release branch that sat open while
`main` moved can absorb a newly added `[Unreleased]` entry through the merge, leaving it on the wrong
side of the new version header. v0.2.0 came within one lucky three-way merge of shipping a fix that
was never recorded in the release that carried it.

## When CI fails on the merge commit

**A deterministic failure cannot be fixed forward on the same commit.** Fixing produces a new commit,
so the original merge SHA stays red permanently, and the version transformation is already on `main`.

- Flaky or infrastructure failure: re-run CI on the same merge SHA, then re-run the tag workflow.
- Deterministic failure: no tag exists yet. Revert the release transformation against the merge
  commit's first parent, merge the fix, and prepare the same version again.

## The changelog gate

**The changelog decision has to happen at PR time, not release time.** Seven dependency PRs merged
in one batch with no entry between them; by the time anyone cut a release the context needed to
write those entries was gone.

**Unknown paths count as shipping.** The exemption list is explicit and everything else fails
closed, so a file type nobody anticipated is never waved through by accident.

**"Shipping" means present in the runtime image, decided against the Dockerfile rather than by
intuition.** That image contains only `.next/standalone`, `.next/static`, `packages/web/public` and
`packages/web/data/packs`. CI config, docs, tests and every `scripts/` directory are therefore
exempt: `CHANGELOG.md` is release notes for people running RuleBeat, not a log of the repo's own
tooling, and the release-integrity work itself was briefly logged there by mistake before this rule
was written down.

**A manifest change ships unless the only key that differs is `scripts`.** Dependency and version
changes are exactly what the gate exists to catch, but adding an npm script reaches nothing, and
treating it as shipping would make every tooling PR need a label.

**`packages/web/public/**` ships; the top-level `brand/**` does not.** There are two `brand`
directories, and only the source kit at the top level is inert. Reversing them would silently exempt
every logo change in the running app.

**Diff changed paths with `--no-renames`.** Otherwise moving a shipping file into `docs/` reports
only the new path, and the change exempts itself.

**Compare `[Unreleased]` against the current base, not the merge base.** A PR that merely merged
`main` in inherits someone else's bullet; measured against the merge base that reads as a new entry
of its own.

**The gate prevents an accidental omission; it is not an adversarial control.** A fork can edit the
checker and report green. That edit is plainly visible in the diff, so review is the mitigation.
`pull_request_target` would make it worse, not better: the job would run fork-authored code with a
writable token.

**A required check whose workflow never runs blocks every PR forever.** No `paths:` filter on
`pr-checks.yml`, and `prepare-release.yml` must dispatch it against the release PR, because a
`GITHUB_TOKEN`-created PR may get no automatic run at all.

## The CHANGELOG itself

**Only a pushed `vX.Y.Z` tag moves `:latest`.** A merge to `main` leaves an unreferenced
`sha-<commit>` image in the registry that nobody pulls, so a change is not shipped to anyone until a
release goes out.

**CHANGELOG.md's own invariants are checked, not trusted.** `check-changelog-structure.mjs` runs
inside `verify-release-version.mjs`'s `main()`, which both `tag-release.yml` and `publish-image.yml`
already call, so the invariants gate tagging and promotion with no workflow wiring. It asserts every
header has a correctly-targeted footer link, `[Unreleased]` points at the newest release, versions
descend, dates are real calendar dates and do not increase, and nothing is duplicated or orphaned.
A header that only looks like a release (`## [0.2]`) is reported rather than skipped, because a
silent skip is how a whole entry disappears from every other check.

**Rewriting version headers does not maintain the reference-link footer.** `bumpChangelog()` moves
sections; the `[Unreleased]: .../compare/...` definitions at the bottom are what make the heading at
the *top* a real link. Left alone they drift: `[Unreleased]` pointed at `v0.1.0` for the whole 0.2.0
cycle, and 0.2.0 had no link at all. `updateChangelogFooterLinks()` runs right after every bump.
