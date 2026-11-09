# Dashboards

![Dashboard with the Overall Posture ring, category scorecard and trend](img/dashboard.png)

The widget catalog, filters and date windows. If the question is what "7 of 12" means, read
[`posture.md`](posture.md) first.

Every widget reads live state from the findings table plus, for trend lines, the daily posture
snapshots. No widget reads the last scan's result blob, so a narrow scheduled run cannot make a
dashboard swing. Suppressed findings are excluded everywhere on a dashboard; the Scans page is where
you see them.

## The widget catalog

<!-- count:widget-types -->Thirteen widget types, added from the Add Widget panel:

| Widget | Shows |
|---|---|
| **Stat Card** | One number from a metric you pick: posture, open findings, critical, high, rules scanned, categories healthy, new or fixed. Carries the window's delta and any unknown count. |
| **Posture Ring** | The "X of Y passing" gauge for one category or overall, with "N not yet proven" underneath. |
| **Trend Chart** | Posture % over time, one series per category. Needs stored history. |
| **Top Violating Rules** | The rules producing the most open findings. |
| **Category Scorecard** | One row per category: passing, open findings, delta. |
| **Recent Findings** | The newest findings, with category, severity and first-seen date. |
| **Severity Breakdown** | A donut of open findings by severity. |
| **Subscription Scorecard** | One row per subscription, graded against the rules that apply to it. |
| **Top Offending Resources** | The resources with the most open findings. |
| **Scan Coverage** | Last scan time per category, badged fresh, recent, stale or never against your threshold. |
| **New vs. Fixed** | Findings first seen against findings fixed, per day. |
| **Activity Occurrences** | Daily findings from activity rules. Empty until the Log Analytics backend lands. |
| **Advisories** | Open Advisories with rule, resource, severity and when each was last seen, most severe first and then most recently seen. Advisories are never counted as problems, so this is the one widget that lists them. A row opens the Advisories tab on Scans. |

Widgets showing findings or rules click through to the Scans page with the same filters applied, so
the list you land on is the list the number counted.

## Filters and scope

A dashboard has one filter bar applied to every widget: categories, subscriptions, resource groups,
tags, severities, rules, and a date window. A funnel indicator appears on each widget title while a
filter is active, so a scoped number never looks global. Tags here are **rule** tags (labels like
`framework:iso27001`), not Azure resource tags.

### Saved filters and changes in the address

A dashboard's filters live in two layers. The **saved filters** are stored on the dashboard, and
everyone who opens it starts from them. Your **changes** live only in the address of the page. Picking
a value in the bar changes that dimension in the address, and nothing else: it saves nothing, adds no
history entry and asks nothing when you leave. Nobody else sees your changes unless you send them the
link, and nothing is kept per person.

Each dimension shows the values in force. A dimension you changed is marked **Changed**, shows a
`Saved: ...` line with what the dashboard saved, and offers **Back to saved**. A changed date window is
marked the same way. **Reset to saved filters** appears while any change exists and puts the whole
bar back in one step. A dimension you set back to its saved value is no longer a change. Clear on one
dimension is an explicit pick of any value for that dimension; there is no Clear for the whole bar.

**Copy link** copies an address that carries only your changes, so the link keeps following the
dashboard's saved filters. Each person who opens it sees what their own Access allows ([`access.md`](access.md)).

**Save as this dashboard's filters.** While changes exist, the bar offers **Save as this dashboard's
filters**. It is the only way the saved filters change: it writes your changes (each changed dimension and the
date window) as what everyone starts from next, then clears the changes from your address. It leaves the
layout and every widget's own Scope alone, and it never runs when you save the layout in edit mode. Someone
who may not edit the dashboard sees it off, with the reason. **Duplicate** sits beside it only for someone
who is allowed to duplicate a dashboard, since the duplicate is refused for everyone else. The save is checked against the revision you opened: if someone saved or edited first, nothing is
overwritten, the bar reloads, your changes stay in the address, and a notice asks you to check them and save
again (see **When someone saved first** below). A save is refused when your changes name values outside your Access (the bar then offers **Remove N
values outside your access**, which takes them out of the address) and when it picks any for a dimension whose
saved values include some you cannot see. Values you cannot see that the dashboard saved are kept when you save
a narrower choice, so a colleague with more Access still gets them.

**When someone saved first.** If the dashboard's saved filters changed after you opened it, **Save as this
dashboard's filters** writes nothing, the bar reloads the new saved filters and your changes stay in the
address. One notice reads "<name or email> changed this dashboard's saved filters at <time>. Your changes are
still in the address. Check them, then save again." When a dimension you did not touch now counts something
else because of that save, the notice adds "This also changed Severity for you." and names it. Saving
again, once you have checked, is a deliberate save over the new revision, also while a layout edit is open
(the notice then adds that the edit is still open). A time from an earlier day shows its date. If the dashboard was deleted,
unshared or handed over while you had it open, the page says "This dashboard is no longer available to
you". If you lost the right to edit it, Save is off with the reason and Duplicate is offered if you may
duplicate.

**Counted values.** A value that your Access does not reach is never named to you. It shows as one row,
"N outside your access", that you cannot tick. It stays in the filter, so your numbers remain the ones your
Access allows. If a dashboard saved a filter to values you hold only part of, unticking your last visible
value is off with the reason "Removing it leaves only values outside your access", because it would widen
the filter for everyone else. It is allowed once the address itself carries the held-back value. Any, on
such a dimension, says that it widens the link for others.

**Values that no longer exist.** A category, tag or rule that was deleted stays in the filter, named, and is
marked "No longer exists" (a deleted rule reads "A rule that no longer exists"). The "Saved: ..." line marks
them the same way. A subscription is called gone only when it has left the management group tree RuleBeat
keeps, and only for someone with access to Everything; anyone else has it counted under "outside your
access". A value that no longer exists matches nothing and is never removed on its own: remove it from the
bar to change the address.

**When the dashboard changes while you have it open.** A number that comes back computed from a newer
revision reloads the filter bar and every widget together, and a notice says so (without asking you to save
again, since you did not try to save). Your changes stay in the
address. If you have a layout edit open, it is not discarded: the notice says so, and the layout of the
newer revision loads once you save or cancel the edit. The bar and the numbers do not wait, so the bar
always describes the filters the numbers were counted with.

A widget that sets its own value for a dimension is not moved by your change. The bar says so under the
dimension, for example "2 widgets use their own severity".

The dashboard tabs, the sidebar and Duplicate open a dashboard with no changes. Renaming a dashboard keeps
the address, and `/dashboard` passes its query on to the default dashboard.

Each widget also has a **Scope** panel with the same dimensions. A value set there **replaces** the
dashboard's value for that dimension on that widget; anything left on inherit takes the dashboard's.
Values never intersect, so if the dashboard is filtered to production and a widget's Scope names the
sandbox subscription, that widget shows the sandbox.

The date window is a rolling preset (24 hours, 7 or 30 days) or a custom range. A preset is stored as
"7 days" rather than two dates, so it keeps rolling. It drives anything that says new, fixed or
delta, the Trend and New vs. Fixed charts, and "vs baseline". It does not change what counts as open.

Three limits a widget will tell you about. Trend needs snapshots at the right grain, so under a
resource group, tag, severity or rule filter, or with two or more subscriptions selected, it says a
trend is not available rather than drawing a misleading blended line
([`posture.md`](posture.md#snapshots-and-trend)); the open-findings delta keeps working under every
filter. A failed data request shows "Couldn't load this widget" with a Retry, while genuinely absent
data shows an empty state, so a broken dashboard cannot pass for a clean tenant. And no enabled
rules in scope shows an empty posture rather than 0% or 100%.

## Managing dashboards

Create a blank dashboard, duplicate one for a per-team variant, rename, delete, set the default, or
Restore starter to recreate the seeded Overview layout. Every dashboard is deletable including the
default; deleting it promotes the oldest remaining one. Layouts save per dashboard, and a layout save
never changes the saved filters or the date window. Creating,
renaming and deleting is audited, and so is saving the dashboard's filters: one "Saved this dashboard's filters" entry per
save, naming the dimensions that changed and never their values. The changes in an address are never audited; dragging and resizing is not, since every drag would be an entry
and would bury real changes. Viewers see every dashboard, editing needs the editor role
([`rbac.md`](rbac.md)).

**Auto-refresh.** The refresh picker in the toolbar, outside edit mode, applies only to the page you
have open. It is not saved and not in the address, so it never changes the dashboard for anyone else, and
it goes back to the saved interval when you reload. The saved interval is set in edit mode and saved
with the layout, like a widget move.

**Old tabs.** Every save of a layout or a name carries the revision of the dashboard you opened, and
the save returns the new one. A save that carries no revision, which is what a tab left open from before
this rule sends, is refused with "This dashboard changed since you opened it. Reload to continue." and
nothing is written. Setting the default needs no revision.
