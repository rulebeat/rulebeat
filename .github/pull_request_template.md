<!--
Lane B (a typo, a copy fix, a one-file bug with an obvious cause, a test, a doc): the four lines
below are all that is asked for.

Lane A (the rule engine, the database shape, auth and access, design tokens, or product shape --
see docs/engineering/how-changes-are-made.md): open an issue with the plan first, then link it here.
-->

**What is wrong**

**What done looks like**

**What I am explicitly not touching**

---

### Changelog

<!--
A PR that changes what the running app does needs one bullet under `## [Unreleased]` in
CHANGELOG.md, in the same commit. Only a pushed vX.Y.Z tag moves :latest, so a change with no entry
has nothing to carry it into a release.

Docs, tests and workflow-only changes are exempt automatically -- no label, nothing to do. The
`no-changelog` label exists for the rare shipping change that genuinely alters nothing a user would
notice, and only a maintainer can apply it.
-->

- [ ] Added an entry under `## [Unreleased]`, or this change does not affect the shipped app.

### Verification

<!-- What you ran. `npm run build:core`, `npm run typecheck`, `npm test` are the standing gate. -->
