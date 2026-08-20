# Suppressions

This page answers: what happens when I suppress a finding, who can do it, how long it lasts, and
where it shows up afterwards. RuleBeat calls this a suppression, not an exception or an exclusion,
because that is what it does: it suppresses one finding from the figures without deleting anything.

## What a suppression is

A suppression is a record attached to one finding's fingerprint (the hash of rule id and resource
id, see [`how-it-works.md`](how-it-works.md#how-a-row-becomes-a-finding)) with:

- a **reason**, required, free text ("approved exception, ticket 4821, storage account is
  internal-only");
- an optional **expiry**; no expiry means it stands until someone removes it;
- the resource id, so the Suppressions page can show what it covers without joining back to the
  finding.

It is created from the finding itself on the Scans page ("Suppress this finding", with the reason
and expiry fields inline) and managed from the Suppressions page.

## What it does

- **Hides the finding from the Results tab by default.** A toggle on the tab shows suppressed
  findings again, with the count, so nothing is hidden without a visible trace.
- **Removes the finding from every posture figure and widget.** If it was the rule's only active
  finding, the rule becomes passing. That is the intended effect and the reason a reason is
  required.
- **Keeps the finding's history.** The finding stays in the table with its status, first seen, last
  seen and times seen. Scans keep updating it. If the underlying problem is fixed, the finding is
  marked fixed like any other; if it is not, it stays active and hidden.
- **Writes an audit entry** (`suppression.create`, with the reason, expiry and fingerprint) and
  another when removed (`suppression.delete`). Who suppressed what, why and when is always
  recoverable. See [`rbac.md`](rbac.md).

## What it does not do

- It does not change the rule, its scope or its query. Other resources failing the same rule are
  unaffected.
- It does not stop the scan from re-evaluating the resource. A suppressed finding is still scanned.
- It does not notify. Suppression is a local bookkeeping act, not a scheduled-run event.
- It does not delete anything, and it is not exported as a separate object. Findings exported to
  CSV or JSON from the Scans page carry their lifecycle columns (status, first seen, last seen, times
  seen) but not a suppression column; export what you see, with the suppressed toggle in whichever
  state you want the file to reflect.

## Expiry

When a suppression expires it stops hiding the finding automatically; there is nothing to run. The
record itself is kept and listed under expired on the Suppressions page, so "why was this hidden
last quarter" still has an answer. Suppress again, with a fresh reason and expiry, to extend it. An
expired suppression does not suppress anything, in the Results tab or on a dashboard.

Use expiry for the common case: a temporary, approved deviation with a review date. Use no expiry
for the permanent ones, and let the Suppressions page be the list you review.

## Who can suppress

Suppressing and removing a suppression are **editor** actions (`suppressions:write`). Viewers see
every suppression, its reason and expiry, and can copy the resource id, but cannot remove one.
Admins can do everything editors can. The role is checked on the server on every request, so a
demoted user loses the ability on their next click, not at their next sign-in. See
[`rbac.md`](rbac.md).

## Surviving upgrades and edits

A suppression is keyed by fingerprint, and a fingerprint is derived from the rule's id and the
resource's id. So:

- Editing a rule's name, description, severity, tags or even its query does **not** touch its
  suppressions. The id did not change.
- Duplicating a rule creates a new rule with a new id; the copy starts with no suppressions.
- Upgrading RuleBeat never changes a built-in rule's id; the upgrade test suite asserts that
  suppressions (and findings, and rules) survive every supported old database shape.
- Moving or renaming an Azure resource gives it a new resource id and therefore a new finding; the
  old finding is resolved on the next successful scan and the suppression on it goes quiet with it.

## Suppressions versus other ways of making a finding go away

| You want | Do this |
|---|---|
| This one resource is an approved deviation | Suppress the finding, with a reason and a review date. |
| This rule should never apply to these resources | Edit the rule's scope or conditions (or its Applies to population) so they are not in it. |
| This rule is not relevant to us | Disable the rule. It leaves the posture total and stops being scanned; its existing findings stay listed on the Scans page, marked Off, until the rule runs again. |
| This finding is real and we fixed it | Nothing. The next successful scan marks it fixed. |
