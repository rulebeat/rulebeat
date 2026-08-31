# Suppressions

RuleBeat calls this a suppression, not an exception or an exclusion, because that is what it does:
it suppresses one finding from the figures without deleting anything.

A suppression is a record attached to one finding's fingerprint (the hash of rule id and resource
id, see [`how-it-works.md`](how-it-works.md#how-a-row-becomes-a-finding)) carrying a required
free-text **reason** ("approved exception, ticket 4821, storage account is internal-only") and an
optional **expiry**. You create it from the finding on the Scans page and manage it from the
Suppressions page. Suppressing and removing are **editor** actions; viewers see every suppression
and its reason but cannot remove one ([`rbac.md`](rbac.md)).

## What it does, and does not

- **Hides the finding from the Results tab**, behind a toggle that shows suppressed findings again
  with their count, so nothing is hidden without a visible trace.
- **Removes it from every posture figure and widget.** If it was the rule's only active finding, the
  rule becomes passing. That is the intended effect and the reason a reason is required.
- **Keeps the finding's history.** Scans keep evaluating the resource and updating status, first
  seen, last seen and times seen. If the problem is fixed, it is marked fixed like any other.
- **Writes an audit entry** on create and on delete, with the reason, expiry and fingerprint.
- It does **not** change the rule, its scope or its query, so other resources failing the same rule
  are unaffected. It does not notify, and it deletes nothing. There is no suppression column in a CSV
  or JSON export; export what you see, with the toggle in whichever state you want reflected.

## Expiry

An expired suppression stops hiding its finding automatically, everywhere. The record is kept and
listed under expired, so "why was this hidden last quarter" still has an answer; suppress again
with a fresh reason to extend it. Use expiry for a temporary approved deviation with a review date,
and no expiry for the permanent ones, letting the Suppressions page be the list you review.

## Surviving upgrades and edits

A fingerprint is derived from the rule's id and the resource's id, so editing a rule's name,
description, severity, tags or even its query does not touch its suppressions. Duplicating a rule
creates a new id, and the copy starts with none. Upgrading never changes a built-in rule's id, and
the upgrade test suite asserts suppressions survive every supported old database shape. Moving or
renaming an Azure resource gives it a new resource id and therefore a new finding; the old one
resolves on the next successful scan and its suppression goes quiet with it.

## Other ways to make a finding go away

| You want | Do this |
|---|---|
| This one resource is an approved deviation | Suppress the finding, with a reason and a review date. |
| This rule should never apply to these resources | Edit the rule's scope, conditions or Applies to population. |
| This rule is not relevant to us | Disable the rule. It leaves the posture total and stops being scanned; existing findings stay listed, marked Off. |
| This finding is real and we fixed it | Nothing. The next successful scan marks it fixed. |
