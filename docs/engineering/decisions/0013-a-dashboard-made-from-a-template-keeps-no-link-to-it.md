# ADR 0013: A dashboard made from a template keeps no link to it

Status: accepted, 2026-10-23 (feature "Audience templates and the Grid dashboard layout").

## Decision

**Templates live only in code.** There is no templates table. New from template makes a Personal
deep copy of the Template's name, description, window, refresh and widgets, and stores nothing
about where it came from, so audience is never stored.

**A fresh install seeds the three Templates as Shared rows. An upgrade seeds none, and a deleted
seeded row is never re-created.** After seeding, those rows are ordinary dashboards.

## Consequences

- A later "update from template" can never reach existing copies, because nothing records which
  dashboards were copies.
- A Template change only affects copies made afterwards.
- An install that deletes a seeded dashboard keeps it deleted. The Template is still offered by
  New from template.
