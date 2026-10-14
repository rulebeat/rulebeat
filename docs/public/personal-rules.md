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

## Copy a library rule

Every rule in the Library, built-in or custom, has a **Copy to personal** action, on its row and on its
page. It makes a new Personal rule with the same name, description, category, severity, tags and query,
and opens it. Anyone who can write a Personal rule can use it; for anyone else the control is
disabled and says why. A Log Analytics rule cannot be copied, and a Microsoft Graph rule needs the
Directory (or Everything).

- The copy starts with no results and no run. Nothing is added to Results, Run History, findings or
  posture, and the shared rule is not changed.
- The copy's scope is cut down to what you hold. Entries of the shared rule's scope that are not a
  subscription or management group you hold are left out. If nothing is left, the scope is empty,
  which means all of the subscriptions and management groups you hold.
- The rule's page says "Copied from" and links to the shared rule. The link goes away when that
  shared rule is deleted; the copy stays.
- The copy is yours to rename, edit and delete. Editing it never changes the shared rule.

## Send a rule to the library

A Personal rule reaches the library only through a **Library request**, because the library is shared by
everyone and is written by an Admin or an Editor on Everything. On the rule's page, **Send to library**
makes a request that holds a copy of the rule as it is when you send it. Edit the rule afterwards and the
request does not change.

- A rule has one open request at a time. The page says when it was sent and that a reviewer has not
  decided yet. **Withdraw** takes it back until they do.
- When a reviewer **rejects** it, the page shows their reason. Edit the rule and use **Resubmit** to send
  it again, or leave it as a Personal rule.
- When a reviewer **approves** it, the page links to the new library rule. Your Personal rule stays as it
  was, and the library rule is a separate rule: editing one never changes the other.
- Deleting a Personal rule withdraws its open request. Removing a person withdraws all of theirs.

### Send an edit as an update

Once a rule is in the library, a later edit of your Personal rule can go back as an **update request**
aimed at one existing custom library rule, instead of as a second copy. On the rule's page, **Send as
update to** offers each rule it can update: the library rule your approved request created, and the
custom library rule your Personal rule was copied from. **Send as new rule** is still there. An update
can be sent after an earlier request was approved, but not while one is open.

- A copy of a built-in rule can only be sent as a new rule. A built-in changes only with a new version,
  so the page shows only the new-rule send and says why.
- An update must use the same backend as the library rule. A Resource Graph rule cannot update a
  Microsoft Graph one.
- The request keeps the library rule's definition as it was when you sent it, so a reviewer can tell if
  it changed since.
- Rejecting, withdrawing and resubmitting work as for any request, and a resubmitted update keeps its
  target.
- If the library rule is deleted while the request is open, the request cannot be approved. A reviewer
  rejects it and you send the rule as a new one.

### Reviewing requests

An Admin, or an Editor on Everything, sees a **Requests** section in the Library with the number of open
requests. Nobody else sees the section or the count. Open a request to read what was sent: the
definition, the query it runs, the scope and who sent it.

- **Preview** runs the query once at your own access, limited to the subscriptions and management
  groups you hold, and shows what it finds. It stores nothing: no finding, scan, Personal rule result
  or last-run time changes.
- **Approve** adds the rule to the library as a new custom rule. Before approving you can change its
  name, category, severity, scope and starting state; everything else is what the author sent. The new
  rule starts disabled unless you turn it on. A name that matches another library rule, ignoring case,
  is refused and the request stays open.
- **Reject** needs a reason, which the author reads on their rule.

An update request is marked in the list and names the library rule it edits. Its page shows a line diff
from that rule as it is now to the definition that was sent (name, description, category, severity,
scope and the query, one per line). When the library rule was edited after the request was sent, a
warning says so, and the diff already compares against the edited rule. Approving an update edits that
library rule in place. It keeps its id, so its open findings, how long they have been open and their
suppressions stay as they are, and the library has the same number of rules. The rule keeps its current
enabled state unless you change it first, so approving never switches off a rule that is scheduled. A
name that matches another library rule, ignoring case, is refused and the request stays open. If the
library rule has been deleted, approval is refused; reject the request instead.

A reviewer can also use **Copy to library** on their own Personal rule to add it straight to the library
with no request. The copy starts disabled. This asks Admins and Editors on Everything the same as
approving does; anyone else is refused, and sends a request instead.

Each request, approval, rejection, withdrawal, preview and copy adds one audit entry that names the rule.
An entry never holds the query or the reason a reviewer gave.

## When your access changes

| What happens to you | What happens to your Personal rules |
|---|---|
| You lose some Scopes | You keep them. A run covers only what you still hold. |
| You hold no subscription or management group | You keep them. Run is disabled, with the reason. |
| You are demoted to Viewer | You keep them and can read them and their last results. You cannot edit, delete or run them. |
| You are removed | They are deleted with their results, together with your private saved queries. Your open Library requests are withdrawn. |

## The audit log

Each run adds one entry that names the rule and the Scope it covered. Creating, editing, deleting and
copying a Personal rule are logged too, as are the Library request steps above. An entry never holds the query or any result.
