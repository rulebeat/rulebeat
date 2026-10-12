# ADR 0009: The Library shows the running version in a column, and "Before versioning" is removed

Status: accepted, 2026-10-12 (issue #246). Supersedes two parts of
[ADR 0004](0004-opt-in-versioned-packs.md): the Library filter by version, and the "Before versioning"
version.

## Decision

**The Library has a Version column, not a filter.** A Version column sits directly after Rule and
shows what each built-in rule runs: `1.0.0` for a RuleBeat Core rule, the upstream commit date
(`2026-06-08`) for an APRL rule. The cell is blank for a Custom rule and for a built-in with no
version. When this install has recorded a newer version, the cell carries a soft-fill "New" chip
whose hover text names the newer version and the running one. The Version filter in the toolbar, its
counts and the "New version" chip beside the rule name are gone. The Retired chip and its line stay.
The Rules tab in `/scans` shows no version information.

**The rule page has one version list.** The Rule version card lists every version recorded for the
rule, newest first, each with its label, date, release note, upstream reference when there is one,
and a Running or New tag. There is no dropdown and no collapsible history. Selecting a version other
than the running one opens the existing before/after review. An admin can switch to any recorded
version, older or newer. A viewer or editor sees the list and the review, and a line saying only an
admin can switch. The card says that a disabled rule moves to the newest version when RuleBeat is
upgraded. A switch starts no scan, is audited as `rule.version` with field names only, and leaves
findings alone until the next scan.

**"Before versioning" is removed.** ADR 0004's first-upgrade step recorded a stored definition that
differed from what ships under a pseudo-version of that name and kept an enabled rule running it.
That version could not be told apart from a real one in the list, sorted before every real version
under a special-cased key, and needed its own label and release note in the product. On the first
start after this change:

- A built-in on `before-versioning` whose pack ships it takes the shipped definition and version,
  enabled or not, and the `before-versioning` record is deleted.
- A built-in stored with no version whose pack ships it takes the shipped definition and version,
  enabled or not. The plan never records "Before versioning" again.
- A built-in no pack ships, on `before-versioning` or with no version, is marked retired (if its
  pack could be read) and keeps its stored definition. Its version becomes null. Nothing records the
  version it ran.
- A Custom rule whose `origin_version` is `before-versioning` has that value cleared, so its origin
  note reads "Duplicated from <rule>." with no "newer version" sentence.
- The step runs inside the seeding transaction, never throws out of startup, changes no id, enabled
  state, tag, finding or suppression, and a second start changes nothing.

The step is decided by `planRuleSeeding()` in `lib/rule-versions.ts`, shared by the SQLite and
Postgres seeders, which only execute it. Stored rows still carry the string `before-versioning`, so
the removal step keeps one private literal. Nothing else in the code names it.

## The exception

ADR 0004 says an upgrade never changes what an enabled rule runs. This decision is the one stated
exception that comes with this change (the APRL query correction from issue #221 is recorded in ADR
0004 and stands on its own): an enabled built-in that was on `before-versioning`, or stored with a
definition that differs from what ships and no version, now runs its pack's shipped definition. The
next scan can flag different resources for those rules, and findings the old definition produced and
the new one does not are fixed by the usual rule-edit behaviour. The rule above stands for every
other case, including every enabled rule on a real version.

## Why

A "Before versioning" entry in a version list is not a version anyone shipped, and the one place the
Library offered a way to find rules with a newer version was a filter that hid the answer to "what
does each rule run?". A column answers both at a glance. A list that offers every recorded version, in
both directions, replaces a dropdown plus a collapsible copy of the same information.

## Considered options

- **Keep "Before versioning" and only hide it from the list.** Rejected. It would stay in the data,
  in the sort order and in the audit summaries.
- **Keep the stored definition of a rule that differs from what ships, as a Custom rule.** Rejected.
  It changes the rule's type and breaks the "same id, same findings" guarantee the rest of the
  upgrade keeps.
- **Keep the Version filter beside the column.** Rejected. A column that can be sorted by eye and a
  filter that selects on the same fact are two ways to do one thing, and the filter's options were
  only ever "new version" and "retired".

## Consequences

- A rule that was kept on its own edited definition by the first versioned release now runs the
  shipped one. The CHANGELOG says so, since the next scan may flag different resources.
- Applying a shipped definition renames the rule to the shipped name. If a Custom rule already holds
  that name, two rules share it. The existing disabled-rule move has the same exposure; neither is
  addressed here.
- A built-in on `before-versioning` that this start's catalogue neither ships nor can retire (its
  pack file is unreadable) keeps its definition and gets a null version.
