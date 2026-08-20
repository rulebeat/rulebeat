# License scope

RuleBeat's platform code (the scanning engine, the web application, the scheduler, RBAC, dashboards,
the rule engine, and every rule pack shipped in `packages/web/data/packs/`) is licensed under Apache-2.0. See
[`LICENSE`](LICENSE) for the full text.

## What Apache-2.0 covers

- `packages/core/` and `packages/web/`: the entire platform.
- Built-in rules (`packages/web/lib/builtin-rules.ts`) and every synced external pack under
  `packages/web/data/packs/`, subject to each pack's own upstream license noted below.
- Documentation under `docs/public/`.

## What it does not cover

- **The RuleBeat name, wordmark, and logo** (`brand/`). These are trademarks, not source code; see
  [`TRADEMARKS.md`](TRADEMARKS.md) for what uses are and aren't permitted. Apache-2.0's own trademark
  clause (§4) already makes this exclusion explicit for any Apache-2.0-licensed project; this file
  says it again in plain language because it's the single most common point of confusion for new
  contributors.
- **rulebeat.com's own marketing site source**, where it lives in a separate repository from this
  one, and not part of this codebase's grant regardless.
- **Internal strategy and marketing planning documents.** These never ship in the public
  repository in the first place (see the publish exclusion list this project maintains internally),
  so there is nothing to license either way.

## Third-party content inside this repository

Some content is synced from an external source and carries its own license, distinct from
Apache-2.0:

| What | License | Attribution |
|---|---|---|
| APRL v2 rule pack (`packages/web/data/packs/aprl-v2.json`) | MIT | © Microsoft Corporation. Azure Proactive Resiliency Library v2. Source and pinned commit recorded in `packages/web/data/packs/pack-manifest.json`. |
| Inter, Inter Tight, IBM Plex Mono (fonts, bundled at build time) | SIL Open Font License 1.1 | See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). |

MIT and OFL are both permissive and compatible with redistribution inside an Apache-2.0 project; they
remain separately licensed rather than being relicensed, since RuleBeat isn't the copyright holder of
either.
