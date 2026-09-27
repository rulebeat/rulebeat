# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Layout: single-context

RuleBeat is one context. `packages/core` and `packages/web` are npm workspaces of the same product and share one vocabulary, so there is one glossary and one decision log for the whole repo.

```
/
├── CONTEXT.md                          ← glossary (created lazily)
├── docs/engineering/decisions/         ← ADRs, one numbered file per decision
│   └── 0001-single-replica-topology.md
└── packages/
    ├── core/
    └── web/
```

ADRs live in `docs/engineering/decisions/`, not `docs/adr/`. Write new ADRs there, numbered `NNNN-<slug>.md`, and add them to `docs/engineering/codebase-map.md`.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root.
- **`docs/engineering/decisions/`**: read ADRs that touch the area you're about to work in.
- **`CLAUDE.md`** and the matching files in **`docs/engineering/conventions/`**: the hard rules for this repo.

If `CONTEXT.md` doesn't exist, **proceed silently**. Don't flag its absence; don't suggest creating it upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates it lazily when terms or decisions actually get resolved.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0001 (single-replica topology), but worth reopening because…_
