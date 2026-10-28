# RuleBeat

RuleBeat is a self-hosted Azure governance tool that runs rules on a schedule and tracks every
finding until it is fixed. This glossary fixes the words used for its concepts.

## Demo

**Demo**:
A RuleBeat instance running on generated data instead of a real tenant. It is writable and shared
by everyone who opens it, returns to its starting state on every Reset, and never reaches Azure,
never runs the scheduler and never sends a notification.
_Avoid_: demo mode, demo profile, read-only demo, sandbox

**Visitor**:
Anyone using a Demo. Every Visitor is signed in automatically as the same admin and sees the
changes other Visitors make.
_Avoid_: guest, demo user

**Recording presentation**:
A Demo shown for screen recordings and screenshots: the banner is hidden, the Reset timer is off, and a partial run's message does not name the Demo. It changes
how the Demo looks and when it resets, never what it can do.
_Avoid_: recording profile, recording mode

**Data set**:
A named, shipped description of a fake estate and its history that a Demo is generated from.
_Avoid_: fixture, scenario, sample data

**Seed**:
The number that, together with a Data set and a release, makes a generated Demo identical every
time.

**Reset**:
Returning a Demo to exactly the state it was generated in, with its dates shifted so history ends
at the moment of the Reset. Runs on a timer, or on demand.
_Avoid_: wipe, reseed, regenerate

**Locked surface**:
A part of the console a Visitor can see but not change in a Demo: the Azure connection, sign-in
configuration and user management.

## Rules

**Custom rule**:
A rule written or duplicated by someone on this install. An update never changes it, even when it
was duplicated from a shipped rule.
_Avoid_: user rule, forked rule

**Rule version**:
The version of a shipped rule's definition. RuleBeat Core rules start at 1.0.0 and are versioned
by RuleBeat; a third-party rule uses the version its upstream gives it, or, when upstream has no
versions, the upstream date of the commit its current definition was taken from. A new version is added beside
the one in use; a rule keeps the version it runs until an admin switches to another, older or newer, from any
recorded version. A disabled rule moves to the newest version when RuleBeat is upgraded. Custom rules have no version yet; they are planned to get one.
_Avoid_: revision

**Pack**:
A named set of shipped rules that is versioned and updated as one source. RuleBeat Core is
RuleBeat's own pack; APRL is a third-party pack. Every shipped rule belongs to exactly one pack,
and the console shows a pack by its name alone.
_Avoid_: library (that is the page listing every rule), rule set, collection, built-in library

**Retired rule**:
A shipped rule its pack no longer ships. It keeps running its last version until someone disables
it. The same word is used for every pack.
_Avoid_: obsolete, deprecated, removed

## Findings

**Finding**:
One rule's result about one resource (for an Activity rule, about one value of its dimension),
tracked from the scan that first returns it until it is
Fixed. It holds every Row the rule's query returned for that resource, so nothing the query
returned is lost. Its age, status, suppression and notifications belong to the finding, not to
its rows, and the same resource found by another rule is a separate finding. A finding that gains
a Row counts as changed. Every rule kind and every query backend follows this.
_Avoid_: issue, violation, alert

**Row**:
One line a rule's query returned. A finding has one or more; views group and filter by rows, but a
group counts findings and the distinct resources they are on, never rows. The screen does not use
the word: inside a finding, a row reads by its place, "2 of 3". A service retirements rule that
returns two retirements for one VM gives one finding with two rows.
_Avoid_: result (ambiguous), record, evidence

**Rule kind**:
What a rule's results mean: a Problem rule, an Activity rule or an Advisory rule. Kind is separate
from severity, category and query backend. A Logs rule is always an Activity rule. A custom rule
is a Problem rule unless someone sets it to Advisory, and it can be switched back. A built-in
rule's kind is set by RuleBeat with its version and cannot be changed on an install. A dashboard
number counts one kind: a count or a roll-up never adds Problem, Activity and Advisory findings
together.
_Avoid_: rule type (that is builtin, community or custom), mode

**Problem rule**:
A rule whose every result is something wrong with a resource. Its findings are failures and are
what posture scores. Info is its lowest severity, not a separate kind.
_Avoid_: compliance rule, state rule

**Advisory rule**:
A rule whose results are things to know about and act on, not failures: a service retirement
that affects resources, an Azure Advisor recommendation. Its findings never count toward posture
or toward any problem count.
_Avoid_: info rule, informational rule, recommendation rule

**Advisory**:
A finding produced by an Advisory rule. It goes through Open, New and Fixed like any finding and
keeps a severity. It differs from a problem only in what it counts toward, never in how it is
stored, shown or grouped.
_Avoid_: notice, recommendation (that is what Azure Advisor calls its own rows), info finding

**Checked**:
A rule that is passing or failing. A Problem rule is checked when its last scan at a Scope finished
for it, and then it is passing or failing. An Activity rule is checked or unknown, never passing,
because activity is not a failure to clear. A rule that is not checked is unknown.
_Avoid_: scanned, evaluated, healthy

**Outcome**:
What a rule's last scan says about it at a Scope: passing, failing or unknown (see Checked). Only an
enabled rule has an outcome, so a disabled rule is counted in no outcome. An outcome belongs to a
rule at a Scope, not to the rule alone: the same rule can pass in one subscription and fail in
another.
_Avoid_: result (a Row is a result), status (that is a finding's)

**Finding age**:
How long a finding has been open: whole UTC days from the day it was first seen to now. A finding
that was Fixed and came back keeps its first-seen date, so reactivating it does not reset its age.
_Avoid_: time open, days open, staleness (that is a dashboard marker)

**New and Fixed (in a window)**:
New is a finding that is open and was first seen in the window. Fixed is a finding that was fixed in
the window. Both are read from the finding's own dates, and Scans shows the same lists as
`status=new` and `status=fixed` with the same window.
_Avoid_: added and removed (that is Compare), opened and closed

## Views

**View**:
A way of looking at findings: which ones (filters) and how they are arranged (grouping, sort).
A view works on any finding from any rule, on its built-in fields and on any column its rule's
query returned. A rule never says how its findings are viewed.
_Avoid_: report, perspective, group column

**Saved view**:
A view kept under a name. Every saved view is shared with everyone on the install.
_Avoid_: favourite, bookmark, preset

## Run History

**Snapshot**:
The findings one past scan returned, as that scan saw them: which findings, with the rule,
severity, title, resource and row count each had then. A snapshot never changes after its scan.
It keeps no rows and has no status; a finding's rows and status belong to the finding as it is
now. A snapshot is not a trend point on the dashboard.
_Avoid_: scan result, history entry, posture snapshot (that is the dashboard's daily trend record)

**Compare**:
Two snapshots of one category set side by side. A finding in only the newer one is added, in only
the older one is fixed, and in both is persisted. Findings are matched by fingerprint.
_Avoid_: diff, delta

## Dashboards

**Dashboard**:
A page of widgets that answers five questions: are we OK and improving, where is it worst, are we
keeping up, can I trust these numbers, and what should I know that is not a failure. It is never a
second findings explorer: a dashboard points at findings, and Scans is where they are listed.
_Avoid_: report, overview (that is one dashboard's name), home

**Widget**:
A count or summary of a list Scans can show (Results, Advisories, Activity, Rules or Run History),
or a labelled trend. A count or summary is a link that opens the list it counts.
_Avoid_: tile, card, panel (that is a layout word)

**Definition line**:
The five sentences a widget shows to say what it counts: what it counts, which rule kinds, out of
what, over which window, and under which filters.
_Avoid_: tooltip, caption, description

**Partial and Stale**:
The dashboard's two markers on a number. Partial means some rules were unknown, so the number does
not cover every rule it should. Stale means a category was not scanned within Stale after. Neither
is a scan's coverage `partial` (a Run History badge for one scan whose rules did not all finish).
_Avoid_: incomplete, outdated

**Set on this widget**:
A widget's own value for a filter level, replacing the dashboard's value for that level, never
intersecting with it.
_Avoid_: scoped, override

**Retired widget**:
A widget type the catalogue no longer offers. It keeps its stored row and shows no number, unlike a
Retired rule, which keeps running. The shared word means RuleBeat no longer offers it and leaves it
where it is.
_Avoid_: deleted widget, removed widget, deprecated

**Trend point**:
One recorded day's value of a trend. It is never a link, because the list it counted no longer
exists as it was, and the widget says why.
_Avoid_: snapshot (that is one past scan's findings)

The filter model's terms (levels, held-back values, the rolling window) are defined with that spec,
not here.

## Access

**Role**:
What someone can do in RuleBeat: Viewer, Editor or Admin. A role is always set in RuleBeat; the
name of an Azure role never decides it.
_Avoid_: permission level, Azure role (that is a role in Azure, which only ever grants a Scope)

**Scope**:
The part of Azure whose findings someone can see and run scans against: Everything, the
Directory, a management group, a subscription or a resource group, never a single resource. A
management group covers whatever sits under it now, including subscriptions added later. A finding
is seen by whoever's Scope contains the place it sits; one RuleBeat cannot place is seen only under
Everything. A rule's kind never changes who sees its findings.
_Avoid_: rule scope (that is where a rule's query looks, a separate thing), tenant scope

**Everything**:
The Scope that covers every finding on the install, including the Directory and findings RuleBeat
cannot place. It is not the tenant root management group.
_Avoid_: whole tenant, global, unrestricted

**Directory**:
The Scope that covers findings about the Entra directory itself, such as an app registration's
expiring secret. These belong to no subscription. Only an Admin grants it, by hand; it is never
mirrored.
_Avoid_: identity scope, tenant (that is the whole Azure tenant)

**Access**:
The Roles a person holds and the Scope each one holds on. Overlapping access adds up: the higher
Role wins where two Scopes meet. An Admin always holds Everything and is never scoped.
_Avoid_: permissions, rights

**Mirrored access**:
Access whose Scopes come from the Azure role assignments of a person's Linked account, kept in
sync with Azure. An Admin picks the one Role it carries. Any role assignment counts, active or
PIM-eligible, held directly or through a group; one on a single resource gives its resource group.
_Avoid_: synced access, Azure-managed access

**Manual access**:
Access whose Scopes an Admin picked by hand, each with its own Role. Nothing in Azure changes it.
Editing a person's Mirrored access by hand, or switching it to manual, turns it into Manual access
with the same Scopes.
_Avoid_: custom access, static access

**Linked account**:
The Azure account whose role assignments a person's Mirrored access follows. An Admin chooses it,
and it may differ from the account the person signs in with, such as their separate admin account.
_Avoid_: Azure identity, mirror account

**Personal rule**:
A rule only its author sees and runs, by hand, on their own Access. It keeps only its latest run's
results, which never count anywhere shared. It reaches the library only through a Library request.
_Avoid_: draft rule, private rule, sandbox

**Library request**:
A request to copy a Personal rule into the library, or to update the rule it became there. An Admin
or an Editor on Everything approves it or rejects it with a reason.
_Avoid_: pull request, promotion, submission

**Install administration**:
Running the RuleBeat install itself: people and their Access, sign-in, the Azure connection,
notifications, the audit log and rule versions. Only an Admin does it, and it has no
Scope.
_Avoid_: tenant admin, global admin
