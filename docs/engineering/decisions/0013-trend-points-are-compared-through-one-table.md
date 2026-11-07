# ADR 0013: Trend points are compared through one table

Status: accepted, 2026-11-07 (issue #440, map #320).

## Decision

**An upgrade may add columns whose default means "not recorded", write new trend points from now
on, and change how readers compare points. It does so through one version-equality table, the only
place equality is decided.** The table is a client-safe module with no database imports, and
`docs/public/posture.md` repeats it under "When two counts are compared", kept in step by a test.

| Level | Formula versions counted equal | Finding-count versions counted equal |
|---|---|---|
| Install-wide, per category | 2 and 3 | 1 |
| One subscription | 3 | 1 |
| The Directory | 3 | 1 |

Formula 1 equals nothing. Finding-count version 0 means "not recorded" and equals nothing. A future
version bump is a one-row edit to the table, plus the matching row in `posture.md`.

**A trend point dated before today (UTC) is never updated or deleted, and a past-dated point is
never inserted.** The one exception is retention: 365 days, plus each (category, level)'s newest
point older than the cutoff. Today's point is last write wins.

**The writer writes only the UTC day of the `now` it is given.** Production callers pass none. A
caller that wants another day is a test, or the Demo.

**Levels.** The Directory level is keyed by `DIRECTORY_SUBSCRIPTION`. Subscription levels are keyed
and compared in lower case, on both sides, everywhere a point is read or replaced.

**A missing subscription or Directory point means "unchanged since the last point".** The writer
stores one when today's already exists or when it differs from the newest earlier point, so readers
carry the earlier point forward instead of reading a gap as zero.

**The trend allow-list is the gate for a filtered number.** A trend, baseline and delta are served
only for the filters whose stored point means the same as the live number: category, the date
window and at most one subscription or the Directory. Any other filter gets no trend, so a filtered
live number is never compared with an unfiltered point. ADR 0014 will widen the list.

**The Demo is exempt.** The Demo generator and Demo Reset's `shiftDemoHistory` write and move dated
points by design, because a Demo's history is generated and its dates shift to end at the Reset.

**Earlier decisions stand.** ADR 0008's sequence still holds: the backfill marker is still set, so
blob emptying runs when it did. This continues ADR 0005's "past snapshots are not rewritten".

**ADR 0014 will bridge through this table.** `posture_snapshots` keeps being written as defined
here: formula 3 and finding-count version 1.

## Considered options

- **Guessing which old points were backfilled, by their shape.** Rejected. A backfilled point and
  an honest one can look alike, and a wrong guess rewrites or discards real history. The upgrade
  leaves every old point as it is and the table decides how it compares.
- **A global version bump.** Rejected. One number for all levels would make install-wide points from
  formula 2 unusable although v3 gives the same figures under Everything, and would throw away
  history for no change in meaning.
- **Option B severity: narrow the denominator by each rule's severity.** Rejected. The rule's
  current severity is not the severity of the finding that made it fail, so no Scans list could
  show the rules the number counted. The denominator stays the same and the measure reads "Rules
  with no <severities> finding".
- **Treating an edited rule as unknown until its next run.** Rejected for this work. It needs a
  "definition changed at" column. It is stated as a limit: an edit counts from the rule's next run.
- **A partial baseline blend.** Rejected. When some categories have no comparable point, building
  the baseline from the rest compares two different sets of rules. The delta is withheld and names
  both dates.

## Consequences

- Each left-over subscription keeps one old point per category after retention, the newest older
  than the cutoff. That is an accepted, bounded cost: one row per category per subscription that
  has left the list.
- Every reader of a stored point goes through the table, so a new definition is one edit there, and
  a test fails when `posture.md` and the module disagree.
- An upgrade changes no stored count. Until the formula-3 change raises the version, subscription
  and Directory points are written as formula 2, which the table refuses at those levels, so
  history stays honest even in a partial release.
- The refresh on every posture input costs one awaited write per touched category. Its bench times
  are filled in by the refresh-on-every-input ticket, laid out as in ADR 0007 (a table of the
  measured figures) with the machine and the backend named. The 1-second limit is this spec's
  threshold, not an existing rule. A measurement over it sends the spec back before the formula-3
  change lands.

Bench times: to be filled in by the refresh-on-every-input ticket.
