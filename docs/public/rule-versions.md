# Rule versions

Every shipped rule belongs to a **Pack** and runs a **Rule version**. RuleBeat Core and APRL
use the same model: upgrading records the new definition beside the running one. An enabled
rule keeps running its current version until an admin chooses another.

A **Custom rule** is one you wrote or duplicated on this install. An upgrade never changes it,
and it has no Rule versions to switch yet. Duplicate a shipped rule to change its query.

## Review and switch

Open a shipped rule from the Library or the Rules tab. Its **Rule version** panel shows the
running version. The selector and **Version history** show every version this install has recorded,
with its date, release note and upstream reference when there is one. **New** means newer than
the running version, not unread.

Choose a version to review every changed definition field before and after. The query also appears
as a line diff: `-` removes a line from the running query, and `+` adds one in the selected version.
An admin can then choose **Switch version**. Viewers and editors can review the same history
and changes, but cannot switch. Save any pending tag or enabled-state changes before switching.

Switching changes only the definition and running version. It does not change enabled state,
tags, suppressions, schedules or the last run status. **It starts no scan.** The next manual or
scheduled scan uses the chosen version. You can return to any recorded version using the same
selector; the install keeps its recorded versions.

If the selected definition would rename the rule to another rule's name, the switch fails and
names the other rule. Nothing changes. Names are compared without regard to case or surrounding
spaces.

## What happens to findings

Nothing happens to findings until the next scan. A successful scan keeps matched findings with
their first-seen date, history and suppressions. Findings the rule no longer returns become
fixed; new matches become new findings. A previously fixed match that returns is reactivated
with its original age. A failed or incomplete scan does not resolve prior findings.

If the version moves the rule to another category, matched findings move on that scan. Dropped
findings resolve under the category they were found in. Historical scans keep what they recorded.
There is no separate finding label for a version switch. See [Posture](posture.md) for why this
can change the passing count.

Each switch writes `rule.version` in the audit log. Its summary names the old and new versions;
its details list changed field names only, never the query, recommendation or other field values.

## Reading the version

RuleBeat Core starts at `1.0.0` and uses semantic versions. A major version changes what the rule
detects, a minor version fixes the query without changing its meaning, and a patch changes text only.
Its date is when this install first recorded the version.

A third-party Pack uses its upstream version when one exists. APRL uses the upstream commit's
date, not the date RuleBeat ran the sync. The full timestamp is stored; the selector shows time
in UTC only when versions of the same rule share a date. The upstream commit is a detail,
not the version label. Audit summaries show the date without the time.

## Upgrades and Retired rules

A new install begins on the newest shipped definitions. On upgrade, an enabled shipped rule
keeps its current version. A disabled one moves to a newer shipped version because nothing it
produces can change while it is disabled.

On the first upgrade that records versions, a stored definition that differs from the shipped one
is recorded as **Before versioning**. An enabled rule keeps that definition, with the shipped
version available beside it. A disabled rule moves to the shipped version.

A **Retired rule** is a shipped rule its Pack no longer ships. It keeps running its last version
until someone disables it. Its panel says **Retired. &lt;Pack label&gt; no longer ships this rule.**
Switching among recorded versions does not remove that status.
