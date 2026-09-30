# ADR 0003: Remove Applies to

Status: accepted, 2026-09-30.

## Decision

Applies to is removed. A rule no longer has an optional population query, and the Rules tab
always shows a rule's result as "N resources affected", never "X of Y affected". Nothing replaces it
in this change.

The removal is complete rather than hidden. The rule form loses the Applies to card, the rule model
loses `appliesTo`, `shape` and `lastPopulationCount`, the scan no longer runs a second query per
rule, and an upgrade drops the `applies_to`, `last_population_count` and `shape` columns from
`rules` on SQLite and Postgres. `POST /api/rules` and `PUT /api/rules/[id]` return 400 when a body
still carries `appliesTo`, so a script written against the old API finds out instead of having the
field silently ignored.

## Why

- **The number could be false.** Y came from its own query and X came from the rule's query, and
  nothing tied the two together. The rule was not filtered by its population, so a finding outside
  the population still counted toward X. "3 of 40 affected" could describe three resources of
  which only one was among the forty.
- **It looked broken in the form.** Applies to conditions never appeared in the KQL the editor
  shows for the rule, which is correct for a separate count query but reads as conditions being
  ignored.
- **It was inconsistent across rules.** No built-in or pack rule used it, so a handful of custom
  rules showed "X of Y" while every other rule on the same tab showed a plain count.
- **Almost nothing used it.** Its only consumer was that one label on the Rules tab. Posture,
  dashboards, notifications and export never read the population count.
- **Raw KQL made it worse.** For a rule saved as raw KQL, the population query was built from the
  resource types still sitting in the form, which could be left over from before the rule was
  rewritten. Y then counted a different set of resources from the one the rule scanned.

## Considered options

- **Keep it and constrain the rule by its population.** Rejected for now. It changes what an
  existing rule matches the moment the field is set, it still leaves raw KQL and Directory rules
  without a denominator, and it is a new feature rather than a fix.
- **Hide the card and keep the data.** Rejected. It keeps a second query running on every scan for
  a number nobody sees, and an API field that is stored but does nothing.
- **Accept `appliesTo` on the API and drop it.** Rejected. A caller would reasonably believe the
  definition was saved.

## What a future population feature must guarantee

Anything that brings back a denominator has to meet both of these, or it should not ship:

- **Y always contains X.** Every finding the rule reports is inside the population by construction,
  for example because the population is derived from the rule's own query, not computed beside it.
- **It applies consistently across rules.** Either every rule on a surface has a denominator,
  including raw KQL, pack and Directory rules, or no rule on that surface shows one. It is not an
  opt-in field that some custom rules happen to carry.

## Consequences

- Applies to definitions are deleted on upgrade. Every other rule field, finding and suppression
  is untouched; the upgrade tests pin that.
- The `shape` column goes with it. Its only meaning was "has Applies to", so it carried nothing
  once the population was gone. `kind` stays as the one classification derived from the backend.
- On SQLite, starting an older release against an upgraded database re-adds the three columns with
  their defaults, so it runs without the deleted definitions. On Postgres the older bootstrap only
  creates the columns with the table, so an older release will not run against an upgraded
  database.
