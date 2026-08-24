# Contributing

RuleBeat's whole platform (the engine, UI, scheduler, RBAC, dashboards, rules, packs) publishes
under Apache-2.0, open to contribution. Fork the repo, branch, and open a pull request against
`main`. For a rule idea, a check you'd like to see, a correction to an existing rule's
recommendation text, or a change to the product itself, [open an issue](https://github.com/rulebeat/rulebeat/issues)
first if you want to talk it through before writing code.

## Working on the code

Three documents cover what this project asks of a change. Read them in this order:

- [`docs/engineering/how-changes-are-made.md`](docs/engineering/how-changes-are-made.md): the two
  lanes, which one your change is in, and the testing rules. Start here.
- [`docs/engineering/conventions/README.md`](docs/engineering/conventions/README.md): rules this
  codebase learned the hard way, each written after something broke. Read every topic file that
  matches what you are touching, not just the closest one.
- [`docs/engineering/codebase-map.md`](docs/engineering/codebase-map.md): where things live.

Local setup is in the [README](README.md#local-development); the short version is `npm install`,
`npm run build:core`, then `npm run dev`. Before opening a pull request, run the same gates CI
runs, all from the repo root:

```bash
npm run build:core     # web imports core's compiled output, so build core first
npm run typecheck      # both packages
npm test               # vitest, both packages (npm run test:core / test:web to narrow)
```

`npm run lint` and the Playwright suite (`npm run test:e2e`) live in `packages/web`; run those
from that directory when your change touches the UI.

## Bug reports

Also via [GitHub issues](https://github.com/rulebeat/rulebeat/issues). Useful things to include:
what you expected, what happened instead, and (if it's a self-hosted deployment issue) the relevant
lines from `docker compose logs`.

## Security issues

Don't open a public issue for a security vulnerability. See [`SECURITY.md`](SECURITY.md) for how to
report one privately.

## Feedback in general

RuleBeat is in a public beta whose whole purpose is feedback, not revenue. If something is
confusing, missing, or wrong, [an issue](https://github.com/rulebeat/rulebeat/issues) describing
it is genuinely useful, even if it isn't a bug in the traditional sense.
