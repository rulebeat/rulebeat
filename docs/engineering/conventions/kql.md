# Lessons: KQL engine, parser, builder, ARG

Read this before touching `packages/core/src/engine/kql.ts`, `runner.ts`, the visual builder, or
anything that generates or parses an Azure Resource Graph query.

The contract, in one line: **whatever the builder generates, the parser parses back, and regenerating
does not change the query.**

---

**Assert `regenerate(regenerate(q)) === regenerate(q)` for every case, not just that the parse was correct.** A round trip that rewrites the query slightly each cycle corrupts a rule progressively; sweep `data/packs/aprl-v2.json` for drift across two cycles before believing a parser change.

**The builder reads more KQL than it can author, so the parser's contract is "never lose anything."** Anything unmappable passes through verbatim (`operator: 'raw'`/`AdvancedPassthroughBlock`) and shown read-only; warning about a supported passthrough trains people to ignore warnings that matter.

**A parser must reject any parse the generator can't write back.** Several condition regexes matched an expression whose field was itself an expression, parsed "successfully," then vanished at generation. 47 of 143 real rules silently lost a `| where` line. Gate every parse on `generate(parsed) !== null`.

**The KQL pipe splitter must track paren depth.** Inner `| where` lines inside `| join (...)` aren't top-level. Split on them and the join loses its closing `)`; track `parenDepth` (string-literal aware) and only start a new clause at depth 0.

**A parser must strip parens that wrap an *entire* clause before splitting it, and only those.** Unwrapping only in the has-an-`or` branch left `| where (A and B)` parsing to zero conditions, and a `between` rule opened twice matched every resource in the tenant. Unwrap only when the opening paren's match is the final character.

**Real-world ARG KQL uses `==`/`!=`, not just `=~`/`!~`.** Portal/APRL-authored queries use the plain operators; parse both or valid queries silently fail to map to the builder.

**Bare KQL literals (`!= true`, `!in (...)`, `field > 5`) need explicit parser cases.** Quoted-value regexes skip them; if the only real condition fails to parse, zero conditions remain and a blank placeholder renders instead of the "advanced KQL" note.

**Normalize real-world KQL in one pre-pass, don't multiply regexes.** A string-aware `normalizeKqlExpr()` (double-quoted strings → single, `<>` → `!=`, `['type']` support) run once fixed 78 unparseable / 116 type-extraction failures across the APRL pack. Adding a double-quote variant to every regex individually doesn't scale.

**A regex character class like `[^)]` does not match newlines.** Any multi-line value list will silently fail to parse against it, so use `[\s\S]+?` instead.

**Write a dedicated `parseKqlToVisualQuery()` rather than routing through a legacy parser.** Reusing an older parser silently drops patterns the newer generator emits; the roundtrip contract is: whatever the builder can generate, the parser must parse back.

**Two operators that compile to byte-identical output are indistinguishable coming back. That's aliasing, not a parser bug.** Prove it with an explicit assertion, then hold the alias to the stricter contract (the query must be unchanged).

**Converting a desired-state rule into violation-form KQL: negate via a direct-negation map where one exists, wrap in `not(...)` only for operators without one** (e.g. `startsWith`/`endsWith`/`matches`).

**A parser round-tripping violation-form KQL back to positive rule-form needs an explicit flip map.** Don't flip the `not(inner)` branch, it already preserves the positive operator.

**When skipping null-producing items while building a joined expression, check "have I emitted anything yet," not the loop index.** The first item might have been the one skipped, so `i === 0` wrongly treats the second item as needing a leading join keyword.

**Advanced KQL builder stages (Compute/Expand/Aggregate/Join/Shape) are a reading tool, not a writing tool.** Hide them from the Add Stage menu but keep the parser intact, rendering them as a shared `AdvancedPassthroughBlock` when parsed from raw KQL.

**ARG's `array_length()` returns null, not 0, on a null/absent property.** Always guard with `isnull()`: `(isnull(x) or array_length(x) == 0)`.

**Azure SDK ARG errors wrap the real message in `err.details[0].message`.** `err.message` alone is a generic correlation-ID envelope, not the actual KQL error.

**An escape-hatch raw-query field (e.g. `rawKql`) that makes "every returned row a finding" must be guarded behind "no structured conditions are set."** Otherwise a rule with neither conditions nor the escape hatch fires on everything.

**The runner must capture every projected KQL column into evidence, not just a hardcoded identity set.** Any column outside a fixed core-fields list is otherwise silently discarded.

**`parseKqlToVisualQuery()` assigns a fresh random id to every stage/group/condition on every call.** Two parses of byte-identical KQL text produce structurally different `visualQuery` objects (differing only by ids). Never diff the raw object for equality/dirty-checking; diff the generated KQL string (`buildQueryFromVisual`'s output) instead, since the generator never emits ids.

**A default-based fallback (`join ?? 'and'`) needs a non-default test fixture to prove the value was preserved, not silently defaulted.** An `and`-join fixture can't tell a working join-flip apart from one that dropped the join and fell back to `and`, so use `or`.

**Two live condition representations can coexist with nothing enforcing they agree.** RuleBeat stored `conditions`/`conditionGroups` (compiled to De Morgan-negated KQL at read time) alongside `rawKql`/`visualQuery` as the real execution authority. The fix was a one-time migration into the new representation and deleting the old path, not reconciling two sources of truth going forward.

**A naive quote-toggle string-boundary loop (`if (ch === strChar) inStr = false`) gets copy-pasted, not shared. Grep for the pattern across the whole file; don't stop at the function named in the bug report.** The bug report named `splitTopLevelOps()`/`splitQ()`; the same unescaped-toggle loop turned out independently reimplemented in `normalizeKqlExpr()`, `splitTopLevelPipes()`, `queryHasTopLevelLimit()`, and twice inside `parseKqlToVisualQuery()`'s paren-depth tracking. The worst-hit one, silently dropping an entire `\| project` clause on the *second* round-trip cycle, was in neither of the two originally named functions.
