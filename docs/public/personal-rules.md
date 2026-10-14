# Personal rules

A Personal rule is a rule only you can see and only you can run. Use one to try a query, or to keep a
check for your own part of the estate, without adding anything to what the install shares.

It is written in the same form as a library rule, on the Resource Graph or Microsoft Graph backend.
Log Analytics rules cannot be written yet, for Personal rules or any other.

## Who can write one

An Editor who holds at least one subscription or management group. Someone who holds only resource
groups, or nothing, is told that a Personal rule needs a subscription. A Viewer cannot write one.
A Microsoft Graph Personal rule also needs the Directory (or Everything).

The scope picker in the form offers only the subscriptions and management groups you hold. Leaving it
empty means all of them.

## Where they live

On the **Personal** tab of the Library. The tab lists your own rules and nothing else. Open one to see
its definition, a **Run** button, and the results of its latest run. A rule that belongs to someone
else reads as not found, for every other person and for an Admin.

## What a run does

Run now is by hand only. A Personal rule has no schedule.

- Resource Graph is sent only the overlap of the rule's own scope and the subscriptions and
  management groups you hold at that moment. The query is not changed and no row is filtered after it
  returns.
- A Microsoft Graph rule runs only when you hold the Directory or Everything.
- The run stores its results and the Scope it covered, and **replaces** the previous run's: no row of
  an earlier run is kept.
- A run that has nothing left to cover is refused, with the reason on the page.

## Where the results show

Only on the rule's own page, under a banner that says they are yours alone and count nowhere else.
The banner also shows when the rule last ran and the Scope it covered. There are no ages, no suppress
action and no history, because nothing here is tracked as a finding.

A Personal rule's results are not in Results, Advisories, Activity, Run History, snapshots,
comparisons, exports, dashboards, saved views, suppressions or posture, and they are not part of any
rule count.

## When your access changes

| What happens to you | What happens to your Personal rules |
|---|---|
| You lose some Scopes | You keep them. A run covers only what you still hold. |
| You hold no subscription or management group | You keep them. Run is disabled, with the reason. |
| You are demoted to Viewer | You keep them and can read them and their last results. You cannot edit, delete or run them. |
| You are removed | They are deleted with their results, together with your private saved queries. |

## The audit log

Each run adds one entry that names the rule and the Scope it covered. Creating, editing and deleting a
Personal rule are logged too. An entry never holds the query or any result.
