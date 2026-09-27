# ADR 0002: One writable, shared Demo that resets, replacing the read-only demo

Status: accepted, 2026-09-27.

## Decision

RuleBeat has exactly one Demo (see `CONTEXT.md`), and it behaves like a hosted live demo. Every
Visitor is treated as the same admin without signing in, can change anything outside the Locked
surfaces, and shares the result with every other Visitor until the next Reset. A Reset returns the
Demo to the state it was generated in, on a timer (hourly by default) and on restart. The
read-only anonymous demo mode is removed, not kept beside it as a second profile.

Three things are fixed in every Demo and no setting changes them: no Azure access, no scheduler,
no outbound notification. The Recording presentation used for screen recordings only hides the banner and
stops the Reset timer. It never changes what the Demo can do.

The Demo generator ships in the published image, so any Demo runs from a pinned release, and the
same Data set, Seed and release always produce the same Demo.

## Why

A read-only demo shows what RuleBeat looks like but not what it is like to use. The most
convincing thing on a live demo is authoring a rule, editing a dashboard or suppressing a finding,
and read-only blocks all of it. Screen recordings of the product need the same writes, and a
read-only demo cannot provide them without a second, differently behaving demo beside it.

The data is synthetic and resets every hour, so the Reset is the guardrail. A Visitor who deletes
everything costs the next Visitors at most one interval. That is why there is no mass-delete
guard, no per-Visitor isolation and no rate limit on writes.

## Considered options

- **Keep read-only, add a separate writable "recording" demo.** Rejected: two behaviours to
  test and document, and the public demo stays the less useful one.
- **Per-Visitor copies of the database.** Rejected: storage and cleanup for every Visitor to
  protect synthetic data that resets anyway.
- **Guard against mass deletes (rate limits, floors on rule and dashboard counts).** Rejected for
  the same reason: the Reset already bounds the damage.

## Consequences

- Admin is open to the public in a Demo. Three Locked surfaces stay read-only because a Reset
  only cleans them up after the fact: the Azure connection (a Visitor could paste a real
  secret), sign-in configuration, and user management. Notification channels stay editable
  because every send is suppressed and recorded as suppressed.
- A Reset overwrites the database, so it refuses any database without the Demo stamp, and the
  Demo is SQLite-only.
- There is no HTTP way to trigger a Reset, since every Visitor is an admin. On-demand Resets are
  a restart or a command inside the container.
- The generator becomes product code, so it is built, tested and shipped like the rest of the app.
