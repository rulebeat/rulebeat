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
- The refresh on every posture input costs one awaited write per touched category. Its bench
  (`npm run bench:trend-points`, ADR 0007's layout) is below. The spec set a 1-second limit. It is held
  to what a person or a concurrent write waits for: the transaction hold per category, and
  `computeWidgetSummary` for Everything. A measurement over it sends the spec back before the formula-3
  change. **The owner decided that the background refresh of every category is not held to it** (see
  below).

Measured on the benchmark harness at 2,000 subscriptions, 30 categories, 240 rules and 50,000
findings (960 suppressed), seed 1, three warm runs. Machine: AMD EPYC-Rome Processor, 4 vCPUs, 8 GB,
Linux 7.0, Node 24.22. SQLite is a file in the temp directory; Postgres is 17.11 on the same machine,
over the loopback, a freshly created database that the bench analyzes after seeding (straight after a bulk
load Postgres has no statistics, and the first refresh could take 14 to 30 s; an install has had them
analyzed by autovacuum). Both runs follow two earlier days of history written by the real writer, so
today's refresh compares with an earlier point at every level.

| Measurement | SQLite before | SQLite now | Postgres 17 before | Postgres 17 now |
| --- | --- | --- | --- | --- |
| One refresh of all 30 categories, first of the day | 24.6 s | 2.6 s | 26.6 s | 3.5 s |
| One refresh of all 30 categories, repeat (every level rewritten), median | 24.5 s | 2.4 s | 26.1 s | 3.7 s |
| Transaction hold, one category: median | 0.72 s | 0.08 s | 0.83 s | 0.13 s |
| Transaction hold, one category: longest | 2.4 s | 0.14 s | 2.0 s | 0.22 s |
| `computeWidgetSummary`, Everything | 15.3 s | 0.57 s | 15.6 s | 0.56 s |
| `computeWidgetSummary`, one category | 0.83 s | 0.25 s | 1.05 s | 0.37 s |
| `computeWidgetSummary`, a person holding 20 subscriptions | 0.32 s | 0.20 s | 0.47 s | 0.26 s |
| Last-scanned read, Everything | 1.4 ms | 2.0 ms | 3.6 ms | 5.3 ms |
| Last-scanned read, a person holding 20 subscriptions | 4.9 ms | 5.9 ms | 9.0 ms | 14.6 ms |

The transaction hold is one category refreshed on its own, so it includes the retention statement
and the queue turn; the figure is an upper bound of the hold itself. "Now" is the cold run of each
measurement, except the rows that name a median. A second Postgres run gave 3.6 s for the first
refresh and 0.68 s for the Everything summary; the longest of any run was under 1 second.

**The owner's decision on the 1-second limit.** One refresh of every category (2.6 s on SQLite, 3.5 s
on Postgres at 2,000 subscriptions) stays over 1 second and is accepted. It runs in the queue, and an
awaited write waits only for the hold of the categories it touched (0.1 to 0.2 s each). The bench
still prints the time and says it is accepted; it does not count it as over the limit. **The limit
stays for `computeWidgetSummary` for Everything, which a person waits for, and for the hold per
category.** Both are under it on both backends.

What got the numbers down, and what it did not change:

- The management group expansion was the first cost: each group is expanded once per read of the tree and
  shared by every subscription and rule scoped to a group (`expandRuleGroup` in `lib/run-scope.ts`), and
  one queued refresh keeps the array it read for all its categories while each category's read holds the
  same nodes (`shareTree` in `lib/db/snapshots.ts`). A tree that changes between two categories' reads is
  not shared.
- The Everything summary then spent most of its time asking, for each of 2,000 rows and each distinct rule
  scope, whether the rule overlaps the row (hundreds of thousands of `scopeForRule` calls, about 0.8 s of its 1.9 s in the profile). A
  subscription held whole now looks its rules up in a list built once per scope shape
  (`wholeSubscriptionsOverlapped` in `lib/rule-overlap.ts`). A row for a person who holds only some
  resource groups of a subscription, and the Directory row, still use `ruleOverlapsScopes`.
- The summary read every open finding in full, including its text columns, and filtered the findings of each
  category with one pass per category. It now reads only the columns a count uses
  (`listFindingDigests` in `lib/db/findings.ts`) and groups the findings by category once.

No number the summary returns changes. A test compares each scorecard row, for seven kinds of person, with the
rule-by-rule definition (`ruleOverlapsScopes` over the Scopes narrowed to the row), and another compares a
digest with the summary of the same finding field by field.

No index is called for: the reads of stored points are not where the time goes, so the lower-case
expression index on `lower(subscription_id)` is not added.
