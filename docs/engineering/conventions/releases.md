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

**A CI job cannot use `origin/main` without asking for it.** `actions/checkout` fetches one ref at
depth 1, so main is neither a remote-tracking ref nor a shared ancestor, and
`git merge-base origin/main HEAD` dies with "fatal: Not a valid object name origin/main". Fetching
it needs an explicit refspec (`+refs/heads/main:refs/remotes/origin/main`) to create the ref, plus
`--unshallow` to supply the history, applied only when the clone is shallow because git refuses it
on a complete repository. The first real release died here, on
`git fetch origin main --depth=0 2>/dev/null || git fetch origin main`: `--depth` is a *clone*
option that fetch rejects, `2>/dev/null` hid that, and the fallback populates `FETCH_HEAD` without
ever creating the ref. It is `scripts/fetch-main-ref.sh` now, with tests, for the same reason the
pull-request context resolution moved out of YAML.

**A fixture that quietly stops reproducing the condition proves nothing.** `git clone --depth 1`
from a plain filesystem path uses git's local transport, which hardlinks the object store and
ignores the depth entirely, so the "shallow" clone comes out complete and every assertion passes
vacuously. Use a `file://` URL, and keep a test asserting the fixture really is shallow.

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

**Nothing may be interpolated into a workflow's shell with `${{ }}` when `jq` can read it instead.**
`toJSON()` pretty-prints across multiple lines, and `$GITHUB_OUTPUT`'s `key=value` form takes
single-line values only, so one label rendered as three lines and the runner killed the step with
`Invalid format '  "dependencies"'` before the checker ran. It hid for as long as every PR had zero
labels, then broke all five open Dependabot PRs the moment `dependabot.yml` began applying
`dependencies`, and it disabled the escape hatch at the same time: applying `no-changelog` is itself
what produces the multi-line value, so the label that exists to unblock a PR guaranteed it could not
pass. `jq -c` cannot emit a multi-line value. Interpolating a fork's branch name or a label into a
`run:` block is also a shell-injection vector, which reading the payload with `jq` removes outright.

**Logic that decides whether a PR can merge does not live inside YAML.** The step above was
untestable where it sat, which is the only reason it shipped broken; it is now
`scripts/resolve-pr-context.sh` with `node:test` cases that run the real script.

**Dependabot's own bumps are exempt, but only when the PR touches nothing but manifests and the
lockfile.** The note that matters is derived at release time from the manifests, so a hand-written
entry would duplicate the line the release generates anyway, and a devDependency bump has no release
note to write at all. The path restriction is what keeps this safe: a dependency branch that also
carries source changes is an ordinary product change, and that is not hypothetical, since the
`@azure/arm-resourcegraph` 5.0.0 bump needed a real edit to `resource-graph.ts` for its moved
`timeout` option. Identity is the author plus the repository plus the `dependabot/` branch prefix,
never the branch name alone.

**A required check whose workflow never runs blocks every PR forever.** No `paths:` filter on
`pr-checks.yml`, and `prepare-release.yml` must dispatch it against the release PR, because a
`GITHUB_TOKEN`-created PR may get no automatic run at all.

## Dependency notes and the bump

**Dependency notes come from the manifests, not from commit subjects.** Anyone can write
`build(deps): bump ...`, a bump can be reverted while its subject still claims it happened,
Dependabot truncates its own titles once they get long (`487d1fb` has no versions in it at all), and
a grouped PR collapses twenty packages into one unparseable sentence. Manifests cannot lie about
their own contents.

**Only direct runtime `dependencies` of the two published packages count.** devDependencies, root
tooling and Actions bumps are not in the image, so they are not release notes.

**A package a human already named in `[Unreleased]` is skipped, never duplicated.** A derived
"from 7.0.13 to 9.0.5" cannot explain impact; 0.2.1's hand-written nodemailer entry did.

**Tag discovery fails closed, except for the very first release.** The previous version is known
exactly, so "that tag is missing while other tags exist" is a shallow clone or an unpushed tag, not
a licence to scan all history. A repository with no version tags at all is a genuine first release
and simply gets no derived notes.

**The bump is read off `[Unreleased]`, and an explicit choice may raise it but never lower it.**
Breaking marker (`### Changed (breaking)` or a `**Breaking:**` bullet) means major; a non-empty
`### Added` means minor; fixes, security and dependencies alone mean patch. A non-empty plain
`### Changed` is ambiguous and refuses to guess, but only when nothing higher already decided:
ambiguity that changes no outcome must not block a release. An empty heading with no bullets is not
a section.

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
