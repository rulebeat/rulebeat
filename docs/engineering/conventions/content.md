# Lessons: user-facing copy, docs and public claims

Read this before writing anything a user reads: UI strings, empty states, error messages, README,
`docs/public/*`, landing page copy, or a blog post.

The governing rule ("copy must not read as AI-written") lives in `docs/engineering/conventions/README.md` because it
applies everywhere. These are the specifics.

---

**An empty/unavailable state must say *why*, not just render the same "no data yet" message as genuinely-empty data.** "This filter combination isn't supported" and "no scans have run yet" are indistinguishable otherwise.

**A "read-only" status label should reflect *why* it's read-only (permanent vs. a currently-inactive edit mode).** When a value is read-only because something else owns it, name that something concretely: which variables, which file, how to restart.

**Before publishing a claim in a README or public doc, trace it to the actual source file, not to an earlier draft or memory of the feature.** A claims-audit pass (one line per claim, one file it's grounded in) caught a stale "governance score" phrase and a rule-count that had drifted from the real seeded default.

**A checked-in example/fixture file can be dead and schema-mismatched with the real code, and nothing will fail until someone reads it as documentation.** Before citing an example file in new docs, grep for any other reference to it and diff its shape against the current types. One had a `scope`/`require`/`globalExcludes` schema from before the KQL rule engine existed.

**Recording a decision in the doc that owns it doesn't propagate it to the docs that merely repeat it.** When RuleBeat's licensing changed, the owning doc was updated the same day, but `README.md`, `CONTRIBUTING.md` and `docs/public/install.md` still described the old model a day later. Grep every narrative doc for the superseded wording whenever a decision changes; one file's update never covers the rest.

**Never bake a positioning line or slogan into a logo/brand image asset.** A baked-in "AZURE GOVERNANCE" caption under the wordmark read as if a third party's name were part of RuleBeat's own brand identity, a real trademark risk, and it was also the one asset with no vector master since it was flat-fill composited rather than traceable line art. It was removed rather than reworded. Any tagline now lives as page copy, so wording can change without regenerating the brand kit.

**Every number a public doc states gets an HTML-comment marker (`<!-- count:KEY -->158`) so `tests/unit/docs-numbers-drift.test.ts` can compare it with the live count.** Counts in README and `docs/public/*.md` had drifted three ways (156/13/10 vs 158/15/12) with nothing to catch it; prose regexes break on rewording, a marker survives it. The marker only catches the stated number, not a missing row: a twelfth dashboard widget shipped with the count correct in one doc while README and `dashboards.md` still said eleven and had no entry for the new widget, caught only by actually running the test.

**Describe what the committed generator or engine does, not what a stale checked-in artifact shows.** The on-disk `data/demo.db` was two rule-shape changes behind `scripts/demo/run.ts`; docs written from the file would have been wrong the moment it was regenerated.
