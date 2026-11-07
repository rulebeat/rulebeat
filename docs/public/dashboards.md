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
tags, severities, rules, and a date window. A funnel indicator appears on the bar and on each widget
title while a filter is active, so a scoped number never looks global. Tags here are **rule** tags
(labels like `framework:iso27001`), not Azure resource tags.

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
Restore starter to recreate the seeded Overview layout. Layouts save per dashboard. Creating,
renaming and deleting is audited, and so is every Save that changes the widgets, the name, the
description or the refresh interval: one entry names the fields it changed, never what they held.
Dragging and resizing is not an entry of its own, since every drag would bury real changes; only the
Save that follows is.

### Personal and Shared

Every dashboard is **Personal** or **Shared**, and has an owner. Anything you make is Personal: a new
dashboard, a Duplicate, one made from a template, and Restore starter. A Personal dashboard is yours
alone. Anyone else, an Admin included, gets "not found" for it, in the address bar and from the API.
Everyone signed in can keep Personal dashboards, a Viewer and a person with no Scope too.

A Shared dashboard opens at `/dashboards/<id>` for anyone signed in, each person seeing what their own
access allows. A person who holds no Scope sees a message that they have been given no access in place of the widgets, since every widget would read empty. Its owner can change it if they are an Editor. An Admin, or an Editor on Everything, can
change any Shared dashboard, including one with no owner (every dashboard from before owners has none).
Anyone who can open a dashboard can Duplicate it: the copy is a Personal dashboard of their own, it is
never the default, and its widgets keep any saved view they point at.

The gallery has two sections. **Yours** lists everything you own, each tagged Personal or Shared.
**Shared by others** lists the Shared dashboards you do not own, with the owner's name, or their email
when they have no name yet, or "No owner". Your own Shared dashboards appear only under Yours.

A name is unique among your own Personal dashboards, whatever its case or surrounding spaces, and nobody
else's Personal names are ever checked, so a clash never tells you what someone else keeps. Renaming a
Shared dashboard checks the names of Shared dashboards across the install. A clash answers 409. Names
that already clash from before keep working.

The Install default is a Shared dashboard chosen by an Admin or an Editor on Everything. Nothing becomes
the default by being first or by being the oldest left: deleting the default leaves the install without
one until it is set again. A new dashboard is never the default.

Creating, renaming and deleting a Personal dashboard is audited by its id and kind only, with no name.
Removing a person deletes their Personal dashboards and leaves their Shared ones Shared with no owner
([`rbac.md`](rbac.md)).

A Save carries the revision it read. If someone saved first, your Save is refused and the page names who changed the dashboard and
when, or says they are no longer in RuleBeat, so two people can no longer overwrite each other
without knowing. Reload to see their version, then make your change again. A name already in use is
refused too, after the revision is checked: a Personal dashboard cannot take a Shared name or one of
your other Personal names, though another person's Personal name is free to take.

A Save is checked before it is written. Each widget type takes only the widths its row of the size
table allows (a stat card is 3, 4 or 6 columns wide, for example), x, y and h are whole numbers of 0
or more, and no two widgets share an id. A widget of a type this version does not know is kept as it
is, at 6 or 12 columns, and cannot be added or changed. A dashboard with no widgets is a valid Save.
A layout stored before these checks is never rewritten or rejected when you open it; it is held to
them on its next Save, and the page moves each width to the nearest allowed one when it saves.
