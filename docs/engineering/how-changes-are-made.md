# How changes are made

This describes what RuleBeat asks of a change before it lands. It is short on purpose. If you are
opening your first pull request, this and [`conventions/README.md`](conventions/README.md) are the
two pages worth reading first.

The reason this exists at all: the expensive mistakes in this project were never typing mistakes.
The design system was built and partly reversed inside a day. The severity scale was designed twice.
Six upgrade bugs were found only after somebody wrote a test suite specifically to look for them.
None of those were coding failures. They were decisions that went into code before anyone wrote them
down and attacked them.

---

## Two lanes

Which lane a change is in is decided by **the files it touches**, not by how big it feels. Effort is
deliberately not part of the test, because effort is the judgment that collapses first under
impatience. A one-line fix to the permissions map is still a design change.

### Lane A: write the plan first

A change is Lane A if it touches **any** of these:

| Surface | Paths |
|---|---|
| Rule engine | `packages/core/src/engine/**` |
| Database shape | `packages/web/lib/db/migrate.ts`, any new table, column, or stored shape |
| Auth and access | `auth.ts`, `auth.config.ts`, `proxy.ts`, `lib/api-auth.ts`, `lib/rbac.ts`, `lib/azure-credential.ts`, `lib/secret-box.ts` |
| Design tokens | `packages/web/app/globals.css`, or the shared UI primitives in `components/ui/**` |
| Product shape | A new page, a new widget, a new setting, or any change to what a user sees or does |

For these, open an issue describing the plan before writing code, and say four things in it:

1. **The problem**, and who it hurts. Not the solution.
2. **What done looks like**, concretely enough that someone else could tell whether you got there.
3. **What you are explicitly not touching.** This line does more work than the other three combined.
4. **What you considered and rejected**, and why.

Then let it be argued with before it becomes a diff. A plan that nobody disagreed with has usually
not been read.

Lane B work that turns out to touch a Lane A path becomes Lane A at that moment, before the edit,
not after.

### Lane B: everything else

A typo, a copy fix, a one-file bug with an obvious cause, a test, a doc. No plan document needed.
State the frame in the pull request in about four lines (what is wrong, what done looks like, what
you are not touching) and build it.

---

## Building

- **Start by re-reading the plan**, and record any deviation from it rather than making it silently.
  A plan that quietly stopped matching the code is worse than no plan, because the next person
  believes it.
- **Tests go in the same commit as the code**, not a follow-up.
- **Name the issue in the commit message.**

## Testing rules

These are not negotiable, and they are the rules the whole suite's value rests on.

- **A failing test means the code is wrong.** Never make a test pass by weakening its assertion. If
  the test's *assumption* was wrong, say so explicitly and get agreement before changing it. Do not
  quietly relax it.
- **Every new test must be seen failing once.** Break the code deliberately, watch it go red, put it
  back. A test that cannot fail is worse than no test, because it looks like coverage.
- **A known but unfixed bug gets `it.fails()`**, never a `skip` and never a softened assertion.
  `it.fails` asserts that the test currently fails, so fixing the bug forces the marker's removal.
- **Test the contract, not the implementation.** Assert on behaviour that survives refactoring. For
  the rule engine specifically, the contract is: whatever the builder generates, the parser parses
  back, and regenerating does not change the query.
- **No live Azure or Graph calls in tests.** `TenantContext` is injectable, so use the fake in
  `tests/helpers/fake-azure.ts`. A test that fails when Azure is slow trains you to ignore red.
- **Every bug found by hand becomes an automated test before it is closed.** This is what stops a
  manual checklist growing until nobody runs it.
- Tests never touch a real database. `tests/setup.ts` points `RULEBEAT_DB_PATH` at a temp file
  before any repository is imported.
- Adding an API route? A structural test fails until that route calls `requireRole`. That is
  intentional. Add the guard rather than an exception.

## What this project deliberately does not do

- **No parallel work on one feature.** Review is the bottleneck, not typing. Producing diffs faster
  than anyone can read them makes the bottleneck worse, not better.
- **No new tooling without a reason traceable to a real delay.** The harness is not the product.
- **No enforcement hooks yet.** They are for things people keep forgetting. Nothing has slipped
  repeatedly enough to justify one.

---

## See also

- [`conventions/README.md`](conventions/README.md): the rules this codebase learned the hard way,
  each one written after something broke.
- [`codebase-map.md`](codebase-map.md): where things live.
- [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md): local setup, and how to propose a rule or
  report a bug.
