# Security

RuleBeat is a read-only tool: it only ever issues read calls to Azure, never creates its own
service principal, and never assigns itself a role. See
[`docs/public/security.md`](docs/public/security.md) for the full detail of what RuleBeat reads,
what it stores, and what it never does.

## Reporting a vulnerability

If you find a security issue in RuleBeat, please report it privately rather than opening a public
GitHub issue. Either channel works:

- Use GitHub's private reporting: open the repository's
  [Security tab](https://github.com/rulebeat/rulebeat/security/advisories/new) and choose
  "Report a vulnerability".
- Email **security@rulebeat.com**.

Include a description of the issue and, if you can, steps to reproduce it.

You should expect an acknowledgment within a few days. RuleBeat is currently maintained by one
person, so please be patient with response time; a fix will be prioritized based on severity and
you'll be credited (if you'd like) once it ships.

Please don't test against anyone else's live deployment, and don't access or modify data that
isn't yours while investigating an issue.

## Supported versions

RuleBeat publishes pinned version tags (starting with `0.1.0`); see the
[releases page](https://github.com/rulebeat/rulebeat/releases) for what's current. While RuleBeat is
in `0.x` public beta, only the most recently released version is supported: security fixes land on
`main` and ship in the next tagged release, and you're expected to be running a recent tag rather
than one several releases behind. There is no long-term-support branch yet.

If you're running an older tag, upgrade to the latest before reporting an issue, in case it's
already fixed; see [`docs/public/install.md`](docs/public/install.md#upgrading) for how to pull a
new tag. Running `:latest` (unpinned) means you're always on the most recently built image, which
carries the newest fixes fastest but with no record of when it changed under you.
